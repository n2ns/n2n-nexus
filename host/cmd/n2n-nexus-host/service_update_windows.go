package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/program"
	"github.com/n2ns/n2n-nexus/host/internal/service"
	"github.com/n2ns/n2n-nexus/host/internal/update"
	"golang.org/x/sys/windows"
)

// The scheduler boundary can be replaced by an in-memory registration in tests.
var registeredUpdateRoot = service.RegisteredServiceRoot
var requestInteractiveUpdate = askInteractiveTask

func interactiveSession() bool {
	var id uint32
	return windows.ProcessIdToSessionId(uint32(os.Getpid()), &id) == nil && id != 0
}

func dispatchServiceUpdate(supervisor int) bool { return supervisor > 0 && !interactiveSession() }
func recoverServiceUpdateAtLogin() bool {
	return interactiveSession() && !windows.GetCurrentProcessToken().IsElevated()
}

// The existing tray refresh notices a new local service startup. It launches
// at most one recovery worker per request, including when the tray opened
// before the S4U host became ready. Idle refreshes perform no network work.
func trayServiceUpdateRecovery() func(*log.Logger) {
	if !update.StableVersion(version) || !recoverServiceUpdateAtLogin() {
		return nil
	}
	file, err := updateRootFile()
	if err != nil {
		return nil
	}
	path := filepath.Join(filepath.Dir(file), "windows-service-pending.json")
	var seen os.FileInfo
	return func(logger *log.Logger) {
		state, err := os.Stat(path)
		if err != nil {
			return
		}
		if seen != nil && os.SameFile(state, seen) && seen.ModTime() == state.ModTime() {
			return
		}
		seen = state
		launchUpdateWorker("service-login", "", logger)
	}
}
func serviceUpdateCommand(args []string) int {
	fs := flag.NewFlagSet("auto-update "+args[0], flag.ContinueOnError)
	root := fs.String("root", "", "service data directory")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		return 2
	}
	logs := host.UpdateLogWriter(config.LogDir())
	defer logs.Close()
	exe := program.Console(executable())
	var err error
	if args[0] == "service-start" && *root != "" {
		if interactiveSession() {
			return 2
		}
		err = queueServiceUpdate(exe, *root, logs)
	} else if args[0] == "service-login" && *root == "" {
		if !recoverServiceUpdateAtLogin() {
			return 0
		}
		err = resumeServiceUpdate(exe, func(root string) int { return autoUpdate([]string{"startup", "--root", root}) })
	} else {
		return 2
	}
	if err != nil {
		fmt.Fprintln(logs, "Windows service startup update:", err)
		return 1
	}
	return 0
}

// A pending request belongs to a single live startup and installation. The
// controlling tray also reads it, independent of Task Scheduler permissions.
type serviceUpdateRequest struct {
	Exe     string
	Root    string
	PID     int
	Started int64
}

func liveServiceUpdate(exe, root string) (serviceUpdateRequest, error) {
	info, err := host.ReadLock(root)
	if err != nil {
		return serviceUpdateRequest{}, err
	}
	if !info.Held || info.Role != host.RoleSupervised || !program.Same(info.Executable, exe) {
		return serviceUpdateRequest{}, nil
	}
	file, err := os.Stat(host.LockFile(root))
	if err != nil {
		return serviceUpdateRequest{}, err
	}
	return serviceUpdateRequest{Exe: exe, Root: root, PID: info.PID, Started: file.ModTime().UnixNano()}, nil
}

func writeUpdateRequest(file string, request serviceUpdateRequest) error {
	tmp, err := os.CreateTemp(filepath.Dir(file), ".windows-service-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(request)
	err = errors.Join(err, tmp.Close())
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), file)
}
func readUpdateRequest(file string) (serviceUpdateRequest, error) {
	var r serviceUpdateRequest
	raw, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	err = json.Unmarshal(raw, &r)
	return r, err
}
func queueServiceUpdate(exe, root string, logs io.Writer) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	registered, err := registeredUpdateRoot(exe)
	if err != nil {
		return err
	}
	if registered == "" || !program.Same(registered, root) {
		return nil
	}
	current, err := liveServiceUpdate(exe, root)
	if err != nil || current.PID == 0 {
		return err
	}
	enabled, err := prepareHostUpdate(context.Background(), "startup", root, "")
	if err != nil || !enabled {
		return err
	}
	file, err := updateRootFile()
	if err != nil {
		return err
	}
	// Record before attempting registration so the interactive tray can recover
	// even when a domain policy prevents this user from registering a task.
	if err = writeUpdateRequest(filepath.Join(filepath.Dir(file), "windows-service-pending.json"), current); err != nil {
		return err
	}
	return requestInteractiveUpdate(trayExecutable(exe), logs)
}
func askInteractiveTask(exe string, logs io.Writer) error {
	if err := service.CheckWindowsPath("updater", exe); err != nil {
		return err
	}
	code, out, err := service.RunPowerShell(service.WindowsInteractiveUpdateScript(exe))
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("interactive task: %s (the login tray can retry)", strings.TrimSpace(out))
	}
	fmt.Fprintln(logs, "Windows service update requested in the owner's interactive session.")
	return nil
}

func resumeServiceUpdate(exe string, check func(string) int) error {
	file, err := updateRootFile()
	if err != nil {
		return err
	}
	dir := filepath.Dir(file)
	path := filepath.Join(dir, "windows-service-pending.json")
	request, err := readUpdateRequest(path)
	if err != nil || request.PID == 0 {
		return err
	}
	if !program.Same(request.Exe, exe) || !filepath.IsAbs(request.Root) {
		return nil
	}
	// The login trigger and the tray may arrive together.
	lock := flock.New(filepath.Join(dir, "windows-service-login.lock"))
	// A tray-launched worker is outside Task Scheduler's Queue policy.
	// Wait for it as well, then re-read the latest request before deciding.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	ok, err := lock.TryLockContext(ctx, 100*time.Millisecond)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("timed out waiting for the interactive service update")
	}
	defer lock.Unlock()
	request, err = readUpdateRequest(path)
	if err != nil {
		return err
	}
	if request.PID == 0 || !program.Same(request.Exe, exe) || !filepath.IsAbs(request.Root) {
		return nil
	}
	registered, err := registeredUpdateRoot(exe)
	if err != nil {
		return err
	}
	if registered == "" || !program.Same(registered, request.Root) {
		return nil
	}
	live, err := liveServiceUpdate(exe, request.Root)
	if err != nil || live.PID != request.PID || live.Started != request.Started || !program.Same(live.Exe, request.Exe) {
		return err
	}
	done := filepath.Join(dir, "windows-service-completed.json")
	completed, err := readUpdateRequest(done)
	if err != nil || completed == request {
		return err
	}
	if check(request.Root) != 0 {
		return fmt.Errorf("check failed; it can retry at the next interactive login")
	}
	return writeUpdateRequest(done, request)
}
