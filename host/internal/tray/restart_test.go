//go:build !darwin || cgo

package tray

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// helperEnv makes the test binary act as the service's serve: "<dataDir>|<port>".
const helperEnv = "N2N_TRAY_TEST_HELPER"

func TestMain(m *testing.M) {
	if v := os.Getenv(helperEnv); v != "" {
		dir, port, _ := strings.Cut(v, "|")
		// A supervised serve: it records a supervisor and answers /health.
		if _, err := host.AcquireLock(dir, os.Getpid(), os.Getppid(), host.RoleSupervised); err != nil {
			os.Exit(3)
		}
		// It restarts on request, as serve under a supervisor does.
		host.WatchRestart(dir, time.Now(), 50*time.Millisecond, nil, func() { os.Exit(0) })
		http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, `{"ok":true,"service":"n2n-nexus","version":"svc","sessions":{"online":2}}`)
		})
		_ = http.ListenAndServe("127.0.0.1:"+port, nil)
		os.Exit(4)
	}
	// No test shows a dialog or a desktop notification on the machine it runs on.
	notify = func(string, string) {}
	os.Exit(m.Run())
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// fakeService writes settings.json for a free port in dir and starts a helper
// serving it; it returns the helper and a channel closed when it exits.
func fakeService(t *testing.T, dir string, s config.Settings) (*exec.Cmd, chan struct{}) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnv+"="+dir+"|"+strconv.Itoa(s.Port))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	for i := 0; ; i++ {
		if _, ok := service.Probe(service.HealthAddr(s.Host, s.Port), time.Second); ok {
			return cmd, exited
		}
		if i == 500 {
			t.Fatal("helper did not answer")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func serviceSettings(t *testing.T, dir string) config.Settings {
	t.Helper()
	s := config.Defaults()
	s.Port = freePort(t)
	if err := config.SaveSettings(dir, s); err != nil {
		t.Fatal(err)
	}
	return s
}

// In controller mode a restart whose service does not come back leaves the
// tray a controller: it never starts a host in-process, which would take the
// lock from the service.
func TestControllerRestartNeverHostsInProcess(t *testing.T) {
	restartWait = time.Second
	t.Cleanup(func() { restartWait = 20 * time.Second })
	told, silent := make(chan string, 1), notify
	notify = func(_, msg string) { told <- msg }
	t.Cleanup(func() { notify = silent })
	dir := t.TempDir()
	s := serviceSettings(t, dir)
	_, exited := fakeService(t, dir, s)
	addr := service.HealthAddr(s.Host, s.Port)
	a := &app{o: Options{Version: "test", DataDir: dir, LogDir: t.TempDir()}, t: english, logger: host.NewLogger(io.Discard), external: addr, settings: s}
	a.mu.Lock()
	a.restartHost()
	h, external, lastErr := a.h, a.external, a.lastErr
	a.mu.Unlock()
	if h != nil {
		h.Stop()
		t.Fatal("restart in controller mode started a host in-process")
	}
	<-exited
	if external != addr || lastErr == nil || lastErr.Error() != english.ServiceDown {
		t.Fatalf("after a restart the service did not come back from: external %q, error %v", external, lastErr)
	}
	if info, _ := host.ReadLock(dir); info.Held {
		t.Fatal("the lock is held after the restart")
	}
	select {
	case msg := <-told:
		if want := fmt.Sprintf(english.ServiceNotBack, 1); msg != want {
			t.Fatalf("the user was told %q, want %q", msg, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the user was not told that the service did not come back")
	}
}

// The status line says whether and where the host runs; the line under it
// is the address a controlling tray's service listens on (from settings, not
// the loopback address the tray probes a LAN host on), or the error.
func TestStatusAndAddressLines(t *testing.T) {
	s := config.Defaults()
	s.Host = "0.0.0.0"
	a := &app{t: chinese, external: "127.0.0.1:5688", settings: s}
	if got, want := a.statusTitle(), "运行中 · 后台服务"; got != want {
		t.Fatalf("status: got %q, want %q", got, want)
	}
	if got, want := a.addressTitle(), "http://0.0.0.0:5688"; got != want {
		t.Fatalf("address: got %q, want %q", got, want)
	}
	s.Host = "127.0.0.1"
	a.settings = s
	if got, want := a.addressTitle(), "http://127.0.0.1:5688"; got != want {
		t.Fatalf("address: got %q, want %q", got, want)
	}
	// The service stopped answering: the status says so and the error takes the address line.
	a.lastErr = errors.New(chinese.ServiceDown)
	if got, want := a.statusTitle(), "未运行"; got != want {
		t.Fatalf("stopped status: got %q, want %q", got, want)
	}
	if got, want := a.addressTitle(), "后台服务无响应"; got != want {
		t.Fatalf("stopped address: got %q, want %q", got, want)
	}
	if a.addressURL() != "" {
		t.Fatalf("stopped URL: %q", a.addressURL())
	}
}

// A restart in controller mode waits for the restarted service and keeps controlling it.
func TestControllerRestartWaitsForTheService(t *testing.T) {
	dir := t.TempDir()
	s := serviceSettings(t, dir)
	_, exited := fakeService(t, dir, s)
	// The supervisor: once the serve ends, start it again.
	go func() {
		<-exited
		time.Sleep(300 * time.Millisecond)
		fakeService(t, dir, s)
	}()
	addr := service.HealthAddr(s.Host, s.Port)
	a := &app{o: Options{Version: "test", DataDir: dir, LogDir: t.TempDir()}, t: english, logger: host.NewLogger(io.Discard), external: addr, settings: s, lastErr: errors.New("stale")}
	a.mu.Lock()
	a.restartHost()
	h, external, lastErr := a.h, a.external, a.lastErr
	a.poll()
	online := a.online
	a.mu.Unlock()
	if h != nil {
		h.Stop()
		t.Fatal("restart in controller mode started a host in-process")
	}
	if external != addr || lastErr != nil || online != 2 {
		t.Fatalf("external %q, error %v, online %d", external, lastErr, online)
	}
}

// A controlling tray logs only to tray.log; host.log is written by the lock holder alone.
func TestTrayLogFiles(t *testing.T) {
	dir, logDir := t.TempDir(), t.TempDir()
	s := serviceSettings(t, dir)
	cmd, exited := fakeService(t, dir, s)
	a, logs := newApp(Options{Version: "test", DataDir: dir, LogDir: logDir})
	defer logs.Close()
	a.mu.Lock()
	a.start()
	a.poll()
	external, online := a.external, a.online
	a.mu.Unlock()
	if external == "" || online != 2 {
		t.Fatalf("controller mode: external %q, online %d", external, online)
	}
	if _, err := os.Stat(filepath.Join(logDir, "host.log")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a controlling tray wrote host.log: %v", err)
	}
	if raw, _ := os.ReadFile(filepath.Join(logDir, "tray.log")); !strings.Contains(string(raw), "the tray only controls it") {
		t.Fatalf("tray.log: %q", raw)
	}

	// Without the service the tray hosts in-process and the host logs to host.log.
	_ = cmd.Process.Kill()
	<-exited
	a.mu.Lock()
	a.start()
	running := a.h != nil
	if running {
		if info, _ := host.ReadLock(dir); info.Role != host.RoleTray {
			t.Errorf("lock role %q, want tray", info.Role)
		}
		n, err := a.h.OnlineSessions()
		a.poll()
		if err != nil || n != 0 || a.online != 0 {
			t.Errorf("online sessions %d %v", n, err)
		}
	}
	a.stopHost()
	a.mu.Unlock()
	if !running {
		t.Fatalf("in-process start: %v", a.lastErr)
	}
	if raw, _ := os.ReadFile(filepath.Join(logDir, "host.log")); !strings.Contains(string(raw), "listening on http://127.0.0.1:") {
		t.Fatalf("host.log: %q", raw)
	}
}

// A controlling tray follows settings.json: when the service comes back on
// another port (service install --port, or an edited file), poll finds it there.
func TestControllerFollowsSettingsChanges(t *testing.T) {
	dir := t.TempDir()
	s := serviceSettings(t, dir)
	cmd, exited := fakeService(t, dir, s)
	a := &app{o: Options{Version: "test", DataDir: dir, LogDir: t.TempDir()}, t: english, logger: host.NewLogger(io.Discard), external: service.HealthAddr(s.Host, s.Port), settings: s}
	_ = cmd.Process.Kill()
	<-exited
	moved := serviceSettings(t, dir) // a new port in settings.json
	fakeService(t, dir, moved)
	a.mu.Lock()
	a.poll()
	external, lastErr, online := a.external, a.lastErr, a.online
	a.mu.Unlock()
	if want := service.HealthAddr(moved.Host, moved.Port); external != want || lastErr != nil || online != 2 {
		t.Fatalf("external %q (want %q), error %v, online %d", external, want, lastErr, online)
	}
}
