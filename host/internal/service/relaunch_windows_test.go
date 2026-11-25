package service

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The replacement waits for the parent to return. Waiting for cmd.Run here
// would retain one old host process after each update.
func TestWindowsRelaunchReleasesPreviousProcess(t *testing.T) {
	marker := os.Getenv("N2N_TEST_RELAUNCH_DONE")
	if marker != "" {
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if err := os.Remove(marker); err == nil {
				return
			}
		}
		t.Fatal("old process waited for replacement")
	}
	marker = filepath.Join(t.TempDir(), "return")
	t.Setenv("N2N_TEST_RELAUNCH_DONE", marker)
	args := os.Args
	os.Args = []string{args[0], "-test.run=^TestWindowsRelaunchReleasesPreviousProcess$"}
	defer func() { os.Args = args }()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := Relaunch(exe); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 4*time.Second {
		t.Fatal("old process retained")
	}
	// Ensure delivery of the signal before the test directory is removed.
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, err := os.Stat(marker); os.IsNotExist(err) {
			return
		}
	}
	t.Fatal("replacement did not acknowledge marker")
}
