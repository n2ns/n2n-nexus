package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/gofrs/flock"

	"github.com/n2ns/n2n-nexus/autoupdate"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/program"
	"github.com/n2ns/n2n-nexus/host/internal/service"
	"github.com/n2ns/n2n-nexus/host/internal/update"
)

func scheduleHostUpdate(action string, args []string) error {
	fs := flag.NewFlagSet("auto-update "+action, flag.ContinueOnError)
	root := fs.String("root", os.Getenv("NEXUS_ROOT"), "data directory of this host")
	method := fs.String("method", "", "installation method: archive, brew or scoop")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 || (action == "off" && len(args) != 0) {
		return fmt.Errorf("unexpected arguments to auto-update %s", action)
	}
	return configureHostSchedule(context.Background(), action, *root, *method)
}

// A missing user scheduler at boot can become available later in the same session.
func startDefaultHostUpdates(root string, logger *log.Logger) func() {
	if !update.StableVersion(version) {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			err := configureHostSchedule(ctx, "default", root, "")
			if err == nil || ctx.Err() != nil {
				return
			}
			logger.Printf("daily updates: %v; retrying in one hour", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Hour):
			}
		}
	}()
	return func() { cancel(); <-done }
}

func configureHostSchedule(parent context.Context, action, root, method string) error {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	file, err := updateRootFile()
	if err != nil {
		return err
	}
	dir := filepath.Dir(file)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, "host-schedule.lock"))
	ok, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("host schedule is busy")
	}
	defer lock.Unlock()
	if root != "" {
		root, err = filepath.Abs(root)
		if err != nil {
			return err
		}
	}
	disabled := filepath.Join(dir, "host-updates-disabled")
	if action == "default" {
		keep, err := adoptHostSchedule(file, root)
		if err != nil {
			return err
		}
		// Manual updates still need to find this instance if the timer is off
		// or no user scheduler is available.
		remember := func() error {
			if keep {
				return nil
			}
			return saveUpdateRoot(root, "default")
		}
		if _, err := os.Stat(disabled); err == nil {
			if err := remember(); err != nil {
				return err
			}
			if _, err := os.Stat(filepath.Join(dir, "host-removal-pending")); os.IsNotExist(err) {
				return nil
			} else if err != nil {
				return err
			}
			action = "off"
		} else if !os.IsNotExist(err) {
			return err
		} else if err := runHostScheduler(ctx, "status", nil); err == nil {
			if keep {
				return nil
			}
		} else {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 3 {
				return errors.Join(err, remember())
			}
		}
	}
	if action == "off" {
		if err := os.WriteFile(disabled, nil, 0600); err != nil {
			return err
		}
		return runHostScheduler(ctx, "off", nil)
	}
	if !update.StableVersion(version) {
		return fmt.Errorf("enable daily updates from an installed stable host release")
	}
	exe, installation := program.Stable(program.Console(executable()))
	if installation == "" || (method != "" && method != installation) {
		return fmt.Errorf("cannot schedule %s as %q (detected installation: %q)", exe, method, installation)
	}
	argv := []string{exe, "auto-update", "run", "--method", installation}
	if action == "on" && root != "" {
		argv = append(argv, "--root", root)
	}
	// A persistent timer can fire as soon as it is enabled.
	if action == "default" {
		if err := saveUpdateRoot(root, action); err != nil {
			return err
		}
	}
	if err := runHostScheduler(ctx, "on", argv); err != nil {
		return err
	}
	if action == "on" {
		if err := saveUpdateRoot(root, action); err != nil {
			return err
		}
	}
	if err := os.Remove(disabled); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Keep explicit choices and other active installations. An automatically bound
// root follows the running host when its previous data directory is inactive.
func adoptHostSchedule(file, root string) (bool, error) {
	setting, err := readUpdateSetting(file)
	if err != nil || setting == nil {
		return false, err
	}
	if !program.Same(setting.Executable, program.Console(executable())) {
		_, err := os.Stat(setting.Executable)
		if os.IsNotExist(err) {
			return false, nil
		}
		return true, err
	}
	if !setting.Default || setting.Root == root {
		return true, nil
	}
	if setting.Root != "" {
		previous, err := host.ReadLock(setting.Root)
		if err != nil || previous.Held {
			return true, err
		}
	}
	return true, saveUpdateRoot(root, "default")
}

func runHostScheduler(ctx context.Context, action string, argv []string) error {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		payload, err := json.Marshal(map[string]any{"component": "host", "action": action, "argv": argv})
		if err != nil {
			return err
		}
		shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		cmd = exec.CommandContext(ctx, shell, service.PowerShellArgs(autoupdate.Windows)...)
		cmd.Env = append(os.Environ(), "N2N_NEXUS_UPDATE_SCHEDULE="+string(payload))
	} else {
		scriptArgs := append([]string{"-c", autoupdate.Unix, "schedule", action, "host"}, argv...)
		cmd = exec.CommandContext(ctx, "/bin/sh", scriptArgs...)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func updateRootFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".local", "share", "n2n-nexus", "updates")
	if runtime.GOOS == "windows" {
		dir = filepath.Join(os.Getenv("LOCALAPPDATA"), "n2n-nexus", "updates")
	}
	return filepath.Join(dir, "host-root.json"), nil
}

type rootSetting struct {
	Root       string
	Executable string
	Default    bool
}

func readUpdateSetting(file string) (*rootSetting, error) {
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var setting rootSetting
	if err = json.Unmarshal(data, &setting); err != nil {
		return nil, err
	}
	if (setting.Root != "" && !filepath.IsAbs(setting.Root)) || !filepath.IsAbs(setting.Executable) {
		return nil, fmt.Errorf("invalid host update settings in %s", file)
	}
	return &setting, nil
}

func savedUpdateRoot() (string, error) {
	file, err := updateRootFile()
	if err != nil {
		return "", err
	}
	setting, err := readUpdateSetting(file)
	if err != nil || setting == nil {
		return "", err
	}
	if program.Same(setting.Executable, program.Console(executable())) {
		return setting.Root, nil
	}
	return "", nil
}

func saveUpdateRoot(root, action string) error {
	file, err := updateRootFile()
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".host-root-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	exe, _ := program.Stable(program.Console(executable()))
	err = json.NewEncoder(tmp).Encode(rootSetting{Root: root, Executable: exe, Default: action == "default"})
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), file)
}
