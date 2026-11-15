package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

// Replaced in tests.
var (
	systemdRunDir = "/run/systemd/system" // exists while systemd is the running system manager
	unitPath      = SystemdUnitPath
	systemctl     = func(args ...string) (string, error) { return run("systemctl", args...) }
)

// checkTarget refuses a machine where systemd is not the running system
// manager (a container, WSL without systemd): Install asks before it stops the
// running host or writes the unit file, which systemctl could not load there.
func checkTarget(target) error {
	if _, err := os.Stat(systemdRunDir); err != nil {
		return fmt.Errorf("systemd is not running on this machine (no %s): the service needs it; start the host with `n2n-nexus-host serve` or the tray instead", systemdRunDir)
	}
	return nil
}

func unitInstalled() bool {
	_, err := os.Stat(unitPath)
	return err == nil
}

func stopService(_ target, out io.Writer) error {
	if !unitInstalled() {
		return nil
	}
	if _, err := systemctl("stop", SystemdUnit); err != nil {
		return err
	}
	fmt.Fprintf(out, "Stopped %s.\n", SystemdUnit)
	return nil
}

func register(t target, out io.Writer) error {
	if err := writeRootFile(unitPath, SystemdUnitFile(t.exe, t.dataDir, t.logDir, t.user), out); err != nil {
		return err
	}
	if _, err := systemctl("daemon-reload"); err != nil {
		return err
	}
	if _, err := systemctl("enable", "--now", SystemdUnit); err != nil {
		return err
	}
	fmt.Fprintf(out, "Enabled and started %s (starts at boot, runs as %s).\n", SystemdUnit, t.user)
	return nil
}

func unregister(_ target, out io.Writer) error {
	if !unitInstalled() {
		fmt.Fprintf(out, "%s is not installed.\n", SystemdUnit)
		return nil
	}
	// The unit file goes even when systemctl fails (no systemd running here):
	// left in place, no later uninstall could remove it. The failure is still returned.
	_, err := systemctl("disable", "--now", SystemdUnit)
	if rmErr := os.Remove(unitPath); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
		return errors.Join(err, rmErr)
	}
	fmt.Fprintf(out, "Removed %s.\n", unitPath)
	if _, reloadErr := systemctl("daemon-reload"); err == nil {
		err = reloadErr
	}
	return err
}

func serviceState(target) string {
	if !unitInstalled() {
		return SystemdUnit + " not installed"
	}
	enabled, _ := systemctl("is-enabled", SystemdUnit)
	active, _ := systemctl("is-active", SystemdUnit)
	return fmt.Sprintf("%s installed, %s, %s", SystemdUnit, enabled, active)
}

func portOwner(port int) string {
	out, _ := run("ss", "-Hltnp", fmt.Sprintf("sport = :%d", port))
	return out
}
