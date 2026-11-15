package service

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
)

func TestSettingsForAppliesFlags(t *testing.T) {
	dir := t.TempDir()
	s := config.Defaults()
	s.MaxAutoTurns = 2
	_ = config.SaveSettings(dir, s)
	got, err := settingsFor(target{dataDir: dir}, Options{Host: "0.0.0.0", Port: 5799})
	if err != nil || got.Host != "0.0.0.0" || got.Port != 5799 || got.MaxAutoTurns != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	got, err = settingsFor(target{dataDir: dir}, Options{Port: -1})
	if err != nil || got.Host != "127.0.0.1" || got.Port != 5688 {
		t.Fatalf("no flags: %+v %v", got, err)
	}
	if _, err := settingsFor(target{dataDir: dir}, Options{Port: 0}); err == nil {
		t.Fatal("port 0 accepted for a service")
	}
}

func TestProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = io.WriteString(w, `{"ok":true,"service":"n2n-nexus","version":"9.9.9","sessions":{"online":3}}`)
		}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	if v, ok := Probe(addr, time.Second); !ok || v != "9.9.9" {
		t.Fatal(v, ok)
	}
	if h, ok := Health(addr, time.Second); !ok || h != (HealthInfo{Version: "9.9.9", Online: 3}) {
		t.Fatal(h, ok)
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"service":"x"}`) }))
	defer other.Close()
	if _, ok := Probe(strings.TrimPrefix(other.URL, "http://"), time.Second); ok {
		t.Fatal("foreign service accepted")
	}
	if HealthAddr("0.0.0.0", 5688) != "127.0.0.1:5688" || HealthAddr("10.0.0.2", 1) != "10.0.0.2:1" || HealthAddr("::1", 2) != "[::1]:2" {
		t.Fatal("HealthAddr")
	}
}

// startLockHelper runs the test binary holding dir's lock in role; it returns
// a channel closed when the helper exits.
func startLockHelper(t *testing.T, dir, role string) (*exec.Cmd, chan struct{}) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnv+"=lock:"+role+":"+dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	for i := 0; i < 500; i++ {
		if info, _ := host.ReadLock(dir); info.Held {
			return cmd, exited
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("helper did not take the lock")
	return nil, nil
}

// Uninstall stops the service's host; a tray hosting the host in-process, or
// a foreground serve, keeps running. Install refuses while a tray holds the lock.
func TestUninstallLeavesATrayRunning(t *testing.T) {
	for _, role := range []string{host.RoleTray, host.RoleServe} {
		dir := t.TempDir()
		_, exited := startLockHelper(t, dir, role)
		var out strings.Builder
		if err := stopServiceHost(dir, &out); err != nil { // what Uninstall runs after removing the service
			t.Fatalf("%s: %v", role, err)
		}
		if !strings.Contains(out.String(), "keeps running") {
			t.Errorf("%s: %q", role, out.String())
		}
		select {
		case <-exited:
			t.Fatalf("the %s holding the lock was terminated", role)
		case <-time.After(500 * time.Millisecond):
		}
		if role != host.RoleTray {
			continue
		}
		for _, err := range []error{refuseTray(dir), StopLockHolder(dir, io.Discard)} {
			if err == nil || !strings.Contains(err.Error(), "quit the n2n-nexus-host tray first; after the service starts, the tray can be opened again and will control it") {
				t.Fatalf("tray holder: %v", err)
			}
		}
		select {
		case <-exited:
			t.Fatal("StopLockHolder terminated the tray")
		case <-time.After(500 * time.Millisecond):
		}
	}
	// The service's own serve is stopped.
	dir := t.TempDir()
	_, exited := startLockHelper(t, dir, host.RoleSupervised)
	if err := refuseTray(dir); err != nil {
		t.Fatal(err)
	}
	if err := stopServiceHost(dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the supervised serve was not stopped")
	}
}

// HealthAddr reaches a host bound to the wildcard of either family (each binds its own family only).
func TestHealthAddrReachesTheHost(t *testing.T) {
	for _, bind := range []string{"0.0.0.0", "::"} {
		t.Run(bind, func(t *testing.T) {
			if bind == "::" {
				ln, err := net.Listen("tcp6", "[::1]:0")
				if err != nil {
					t.Skipf("this machine has no IPv6 loopback: %v", err)
				}
				ln.Close()
			}
			s := config.Defaults()
			s.Host, s.Port, s.DiscoveryPort = bind, 0, 0
			h, err := host.Start(host.Options{Version: "test", DataDir: t.TempDir(), Settings: s, Logger: host.NewLogger(io.Discard)})
			if err != nil {
				t.Fatal(err)
			}
			addr := HealthAddr(bind, h.Addr.Port)
			_, ok := Probe(addr, time.Second)
			h.Stop()
			if !ok {
				t.Errorf("host bound to %s does not answer on %s", bind, addr)
			}
		})
	}
}

// Reading the lock takes it for a moment, which a serve that is just starting
// would find taken: after the service is registered, the lock is read only once a host answers.
func TestAwaitHostReadsTheLockOnlyOnceAHostAnswers(t *testing.T) {
	reads := 0
	readLock = func(dir string) (host.LockInfo, error) { reads++; return host.ReadLock(dir) }
	t.Cleanup(func() { readLock = host.ReadLock })

	closed := httptest.NewServer(http.NotFoundHandler())
	nobody := strings.TrimPrefix(closed.URL, "http://")
	closed.Close()
	awaitHost(t.TempDir(), nobody, 2)
	if reads != 0 {
		t.Fatalf("the lock was read %d time(s) while no host answered", reads)
	}

	// A host answers and holds the lock: one read, no waiting.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"service":"n2n-nexus","version":"1","sessions":{"online":0}}`)
	}))
	defer srv.Close()
	dir := t.TempDir()
	l, err := host.AcquireLock(dir, os.Getpid(), 0, host.RoleSupervised)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	started := time.Now()
	awaitHost(dir, strings.TrimPrefix(srv.URL, "http://"), 50)
	if reads != 1 || time.Since(started) > 5*time.Second {
		t.Fatalf("answering host: %d lock read(s) in %s", reads, time.Since(started))
	}
}

func TestStopLockHolderWithoutHolder(t *testing.T) {
	var stopped []int
	stopPID = func(pid int) error { stopped = append(stopped, pid); return nil }
	t.Cleanup(func() { stopPID = StopPID })
	dir := t.TempDir()
	if err := StopLockHolder(dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	// A released lock with a stale record stops nothing: its PIDs may be other processes by now.
	// (PIDs no system assigns, so nothing is signalled even if this fails.)
	l, err := host.AcquireLock(dir, 1<<30, 1<<30+1, host.RoleSupervised)
	if err != nil {
		t.Fatal(err)
	}
	l.Release()
	if info, _ := host.ReadLock(dir); info.Held || info.PID != 1<<30 || info.Supervisor != 1<<30+1 {
		t.Fatalf("stale record: %+v", info)
	}
	if err := StopLockHolder(dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(stopped) != 0 {
		t.Fatalf("stopped %v from the record of a lock nobody holds", stopped)
	}
}
