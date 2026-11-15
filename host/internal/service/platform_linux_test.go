package service

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// noSystemd makes this machine one where systemd is not the system manager
// (a container, WSL without systemd): systemctl fails, and the unit file is in a temporary folder.
func noSystemd(t *testing.T) (calls *[]string) {
	t.Helper()
	oldDir, oldPath, oldCtl := systemdRunDir, unitPath, systemctl
	t.Cleanup(func() { systemdRunDir, unitPath, systemctl = oldDir, oldPath, oldCtl })
	dir := t.TempDir()
	systemdRunDir, unitPath = filepath.Join(dir, "run-systemd-system"), filepath.Join(dir, SystemdUnit)
	calls = new([]string)
	systemctl = func(args ...string) (string, error) {
		*calls = append(*calls, strings.Join(args, " "))
		return "", errors.New("System has not been booted with systemd as init system (PID 1). Can't operate.")
	}
	return calls
}

// Install asks checkTarget before it stops the running host or writes anything.
func TestInstallNeedsSystemd(t *testing.T) {
	calls := noSystemd(t)
	err := checkTarget(target{})
	if err == nil || !strings.Contains(err.Error(), "systemd is not running") {
		t.Fatalf("without systemd: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("systemctl ran: %v", *calls)
	}
	if err := os.Mkdir(systemdRunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkTarget(target{}); err != nil {
		t.Fatalf("with systemd: %v", err)
	}
}

// A unit file left where systemctl fails is still removed, and the failure is reported.
func TestUninstallRemovesTheUnitWithoutSystemd(t *testing.T) {
	noSystemd(t)
	if err := os.WriteFile(unitPath, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	err := unregister(target{}, &out)
	if _, statErr := os.Stat(unitPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("the unit file is still there (%v)", statErr)
	}
	if err == nil || !strings.Contains(err.Error(), "not been booted with systemd") || !strings.Contains(out.String(), "Removed "+unitPath) {
		t.Fatalf("err %v, output %q", err, out.String())
	}
	// Removed: a second uninstall has nothing to do.
	if err := unregister(target{}, io.Discard); err != nil {
		t.Fatal(err)
	}
}
