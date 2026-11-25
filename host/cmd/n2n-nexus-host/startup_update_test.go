package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// A copy of the test executable stands in for an installed stable release,
// including the child that inspects the on-disk build and the detached worker.
func TestMain(m *testing.M) {
	if marker := os.Getenv("N2N_TEST_STARTUP_WORKER_DONE"); marker != "" {
		version = "1.2.3"
		if len(os.Args) > 2 && os.Args[1] == "auto-update" && os.Args[2] == "startup" {
			code := autoUpdate(os.Args[2:])
			_ = os.WriteFile(marker, []byte{byte(code)}, 0600)
			os.Exit(code)
		}
		main()
		return
	}
	os.Exit(m.Run())
}

func TestHostChecksEachStartWithoutWaitingForNetwork(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "custom data")
	marker := filepath.Join(dir, "worker-done")
	for k, v := range map[string]string{"N2N_TEST_STARTUP_WORKER_DONE": marker, "HOME": dir, "USERPROFILE": dir, "LOCALAPPDATA": dir, "XDG_STATE_HOME": dir, "XDG_CACHE_HOME": dir, "NEXUS_ROOT": ""} {
		t.Setenv(k, v)
	}
	exe := filepath.Join(dir, "n2n-nexus-host")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(exe, data, 0700); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	release := make(chan struct{})
	entered := make(chan struct{})
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "api.github.com:443" {
			t.Errorf("unexpected request %s %s", r.Method, r.Host)
		}
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		w.WriteHeader(502)
	}))
	defer proxy.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	for _, k := range []string{"HTTPS_PROXY", "https_proxy"} {
		t.Setenv(k, proxy.URL)
	}
	for _, k := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(k, "localhost,127.0.0.1")
	}
	cli := func(wantOK bool, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, exe, args...).CombinedOutput()
		if (err == nil) != wantOK {
			t.Fatalf("%v: %s %v", args, out, err)
		}
	}
	start := func(wantCalls int32, enabled bool) {
		t.Helper()
		_ = os.Remove(marker)
		cmd := exec.CommandContext(t.Context(), exe, "serve", "--root", root, "--port", "0")
		cmd.Stderr = io.Discard
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
		if wantCalls == 1 {
			select {
			case <-entered:
			case <-time.After(15 * time.Second):
				t.Fatal("missing startup check")
			}
		}
		for end := time.Now().Add(15 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			info, err := host.ReadLock(root)
			if err == nil && info.Held && info.Address != "" {
				if v, ok := service.Probe(info.Address, time.Second); ok && v == "1.2.3" {
					break
				}
			}
			if time.Now().After(end) {
				t.Fatal("host not healthy during check")
			}
		}
		if wantCalls == 1 {
			close(release)
		}
		for end := time.Now().Add(15 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			b, err := os.ReadFile(marker)
			if err == nil && len(b) == 1 {
				if (b[0] != 0) != enabled {
					t.Fatalf("offline worker exit %v, enabled %v", b, enabled)
				}
				break
			}
			if time.Now().After(end) {
				t.Fatal("worker did not finish")
			}
		}
		if n := calls.Load(); n != wantCalls {
			t.Fatalf("requests=%d, want %d", n, wantCalls)
		}
	}
	start(1, true)
	start(2, true)
	cli(true, "auto-update", "off")
	start(2, false)
	file, err := updateRootFile()
	if err != nil {
		t.Fatal(err)
	}
	setting, err := readUpdateSetting(file)
	if err != nil || setting == nil || setting.Root != root {
		t.Fatalf("manual root after off: %+v, %v", setting, err)
	}
	cli(false, "auto-update", "run")
	if calls.Load() != 3 {
		t.Fatal("off suppressed manual check")
	}
	cli(true, "auto-update", "on")
	start(4, true)
}
