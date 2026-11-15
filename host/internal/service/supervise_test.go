package service

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/host"
)

// helperEnv makes the test binary act as a fake serve child.
const helperEnv = "N2N_SUPERVISE_TEST_HELPER"

func TestMain(m *testing.M) {
	switch mode := os.Getenv(helperEnv); {
	case strings.HasPrefix(mode, "count:"):
		// Record one start (with the supervisor PID it was given) and exit at once.
		f, err := os.OpenFile(strings.TrimPrefix(mode, "count:"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(3)
		}
		fmt.Fprintf(f, "%s %s\n", os.Getenv(host.SupervisorEnv), strings.Join(os.Args[1:], " "))
		f.Close()
		os.Exit(1)
	case strings.HasPrefix(mode, "sleep:"):
		_ = os.WriteFile(strings.TrimPrefix(mode, "sleep:"), []byte(strconv.Itoa(os.Getpid())), 0o600)
		time.Sleep(time.Minute)
		os.Exit(0)
	case strings.HasPrefix(mode, "lock:"):
		// Hold the data directory's lock in a role: "lock:<role>:<dir>".
		role, dir, _ := strings.Cut(strings.TrimPrefix(mode, "lock:"), ":")
		if _, err := host.AcquireLock(dir, os.Getpid(), 0, role); err != nil {
			os.Exit(3)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestSuperviseRestartsTheChild(t *testing.T) {
	file := filepath.Join(t.TempDir(), "starts")
	t.Setenv(helperEnv, "count:"+file)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Supervise(ctx, SuperviseOptions{Exe: os.Args[0], Args: []string{"serve", "--root", "x"}, Out: io.Discard, Logger: log.New(io.Discard, "", 0), Delay: 50 * time.Millisecond})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, _ := os.ReadFile(file)
		if strings.Count(string(raw), "\n") >= 3 {
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			want := fmt.Sprintf("%d serve --root x", os.Getpid())
			if lines[0] != want {
				t.Fatalf("child saw %q, want %q", lines[0], want)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restarts: %q", raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Supervise did not return")
	}
}

func TestSuperviseStopsTheChildWhenSignalled(t *testing.T) {
	file := filepath.Join(t.TempDir(), "pid")
	t.Setenv(helperEnv, "sleep:"+file)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Supervise(ctx, SuperviseOptions{Exe: os.Args[0], Out: io.Discard, Logger: log.New(io.Discard, "", 0), Delay: time.Hour})
	}()
	var pid int
	for i := 0; pid == 0 && i < 500; i++ {
		raw, _ := os.ReadFile(file)
		pid, _ = strconv.Atoi(string(raw))
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("child did not start")
	}
	cancel()
	// Well under the 10 s after which Supervise kills a child that ignored the request to end.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Supervise did not return: the child was not asked to end")
	}
	if runtime.GOOS != "windows" {
		p, _ := os.FindProcess(pid)
		if err := p.Signal(syscall.Signal(0)); err == nil {
			t.Fatalf("child %d still runs", pid)
		}
	}
}
