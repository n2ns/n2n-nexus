package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/gofrs/flock"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/program"
	"github.com/n2ns/n2n-nexus/host/internal/service"
	"github.com/n2ns/n2n-nexus/host/internal/update"
)

func setHostStartupUpdates(action string, args []string) error {
	fs := flag.NewFlagSet("auto-update "+action, flag.ContinueOnError)
	root := fs.String("root", os.Getenv("NEXUS_ROOT"), "data directory of this host")
	method := fs.String("method", "", "installation method: archive, brew or scoop")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 || (action == "off" && len(args) != 0) {
		return fmt.Errorf("unexpected arguments to auto-update %s", action)
	}
	_, err := prepareHostUpdate(context.Background(), action, *root, *method)
	return err
}

// Run outside the serving process: activating an update can replace that process.
// The child inherits no stdio pipes; neither checking the network nor verifying
// the restarted listener is on the host's startup or shutdown path.
func startHostUpdate(root string, logger *log.Logger) {
	launchUpdateWorker("startup", root, logger)
}

func launchUpdateWorker(action, root string, logger *log.Logger) {
	if !update.StableVersion(version) {
		return
	}
	exe, err := service.Executable()
	if err != nil {
		logger.Printf("locate host for update check: %v", err)
		return
	}
	args := []string{"auto-update", action}
	if root != "" {
		args = append(args, "--root", root)
	}
	cmd := exec.Command(program.Console(exe), args...)
	detachUpdateWorker(cmd)
	if err := cmd.Start(); err != nil {
		logger.Printf("start update check: %v", err)
		return
	}
	go func() { _ = cmd.Wait() }()
}

// Serialize preference/root writes, not the network check. Run owns the
// per-installation update lock shared with the manual command.
func prepareHostUpdate(ctx context.Context, action, root, method string) (bool, error) {
	file, err := updateRootFile()
	if err != nil {
		return false, err
	}
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return false, err
	}
	lock := flock.New(filepath.Join(dir, "host-preferences.lock"))
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ok, err := lock.TryLockContext(wait, 50*time.Millisecond)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, fmt.Errorf("host update preferences are busy")
	}
	defer lock.Unlock()
	disabled := filepath.Join(dir, "host-updates-disabled")
	if action == "off" {
		return false, os.WriteFile(disabled, nil, 0600)
	}
	if !update.StableVersion(version) {
		return false, fmt.Errorf("startup updates require a stable host release")
	}
	exe, installation := program.Stable(program.Console(executable()))
	if installation == "" || (method != "" && method != installation) {
		return false, fmt.Errorf("unsupported installation %s (detected %q, requested %q)", exe, installation, method)
	}
	if root != "" {
		root, err = filepath.Abs(root)
		if err != nil {
			return false, err
		}
	}
	if action == "on" {
		if root != "" {
			if err := saveUpdateRoot(root, "on"); err != nil {
				return false, err
			}
		}
		if err := os.Remove(disabled); err != nil && !os.IsNotExist(err) {
			return false, err
		}
		return false, nil
	}
	// Keep manual targeting even when startup checks are disabled.
	keep, err := keepUpdateRoot(file, root)
	if err != nil {
		return false, err
	}
	if !keep {
		if err := saveUpdateRoot(root, "default"); err != nil {
			return false, err
		}
	}
	_, err = os.Stat(disabled)
	if os.IsNotExist(err) {
		return true, nil
	}
	return false, err
}

// Keep explicit choices and other active installations. An automatically bound
// root follows the running host when its previous data directory is inactive.
func keepUpdateRoot(file, root string) (bool, error) {
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
	return false, nil
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
