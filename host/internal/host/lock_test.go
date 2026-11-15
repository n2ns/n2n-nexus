package host

import (
	"io"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

func TestLockIsExclusiveAndRecordsPIDs(t *testing.T) {
	dir := t.TempDir()
	if info, err := ReadLock(dir); err != nil || info.Held {
		t.Fatalf("fresh dir: %+v %v", info, err)
	}
	l, err := AcquireLock(dir, 1234, 99, RoleSupervised)
	if err != nil {
		t.Fatal(err)
	}
	info, err := ReadLock(dir)
	if err != nil || !info.Held || info.PID != 1234 || info.Supervisor != 99 || info.Role != RoleSupervised {
		t.Fatalf("held lock: %+v %v", info, err)
	}
	_, err = AcquireLock(dir, 5678, 0, RoleServe)
	if err == nil || err.Error() != "another n2n-nexus-host is running for "+dir+" (PID 1234)" {
		t.Fatalf("second lock: %v", err)
	}
	l.Release()
	if info, _ := ReadLock(dir); info.Held {
		t.Fatal("still held after Release")
	}
	// A shorter record replaces a longer one completely.
	l, err = AcquireLock(dir, 7, 0, RoleTray)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	if info, _ := ReadLock(dir); info.PID != 7 || info.Supervisor != 0 || info.Role != RoleTray {
		t.Fatalf("re-acquired: %+v", info)
	}
}

func TestStartRefusesASecondHost(t *testing.T) {
	dir := t.TempDir()
	s := config.Defaults()
	s.Port = 0
	opts := Options{Version: "test", DataDir: dir, Settings: s, Logger: NewLogger(io.Discard)}
	h, err := Start(opts)
	if err != nil {
		t.Fatal(err)
	}
	stop := sync.OnceFunc(h.Stop)
	t.Cleanup(stop) // a failed check below does not leave the host running
	if info, _ := ReadLock(dir); !info.Held || info.PID != os.Getpid() || info.Role != RoleServe {
		t.Fatalf("lock while running: %+v", info)
	}
	if !strings.HasPrefix(ReadyLine("test", h), "test listening on http://127.0.0.1:") {
		t.Fatal(ReadyLine("test", h))
	}
	if _, err := Start(opts); err == nil || !strings.Contains(err.Error(), "another n2n-nexus-host is running for "+dir) {
		t.Fatalf("second Start: %v", err)
	}
	stop()
	h2, err := Start(opts)
	if err != nil {
		t.Fatalf("Start after Stop: %v", err)
	}
	h2.Stop()
}
