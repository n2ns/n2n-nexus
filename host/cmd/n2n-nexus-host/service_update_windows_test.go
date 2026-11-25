package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/host"
)

func TestLoginRecoversPendingServiceUpdate(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	root := filepath.Join(dir, "custom root")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	exe := executable()
	originalVersion, originalRegistration, originalSchedule := version, registeredUpdateRoot, requestInteractiveUpdate
	t.Cleanup(func() {
		version = originalVersion
		registeredUpdateRoot = originalRegistration
		requestInteractiveUpdate = originalSchedule
	})
	version = "1.2.3"
	registered := root
	registeredUpdateRoot = func(string) (string, error) { return registered, nil }
	requestInteractiveUpdate = func(string, io.Writer) error { return errors.New("mock policy denies task registration") }
	run := func(pid int) *host.Lock {
		l, err := host.AcquireLock(root, pid, 100, host.RoleSupervised)
		if err != nil {
			t.Fatal(err)
		}
		if err := host.RecordListener(root, "127.0.0.1:9999", exe, version, 5, "digest"); err != nil {
			t.Fatal(err)
		}
		return l
	}
	l := run(111)
	defer func() { l.Release() }()
	queue := func() {
		if err := queueServiceUpdate(exe, root, io.Discard); err == nil || err.Error() != "mock policy denies task registration" {
			t.Fatal(err)
		}
	}
	queue()
	calls := 0
	check := func(got string) int {
		if got != root {
			t.Errorf("wrong service root %s", got)
		}
		calls++
		return 0
	}
	registered = t.TempDir()
	if err := resumeServiceUpdate(exe, check); err != nil || calls != 0 {
		t.Fatal("stale service registration", err, calls)
	}
	registered = root
	wrong := filepath.Join(dir, "other copy.exe")
	if err := os.WriteFile(wrong, []byte("other"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := resumeServiceUpdate(wrong, check); err != nil || calls != 0 {
		t.Fatal("other installation", err, calls)
	}
	if err := resumeServiceUpdate(exe, check); err != nil || calls != 1 {
		t.Fatal("tray recovery", err, calls)
	}
	if err := resumeServiceUpdate(exe, check); err != nil || calls != 1 {
		t.Fatal("duplicate login", err, calls)
	}
	l.Release()
	l = run(222)
	if err := resumeServiceUpdate(exe, check); err != nil || calls != 1 {
		t.Fatal("old request for new startup", err, calls)
	}
	queue()
	// Another service start while the tray (outside Task Scheduler's queue)
	// holds the login lock must still run once the earlier worker has returned.
	entered := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		first <- resumeServiceUpdate(exe, func(root string) int { close(entered); <-release; return check(root) })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first worker did not start")
	}
	l.Release()
	l = run(333)
	queue()
	go func() { second <- resumeServiceUpdate(exe, check) }()
	select {
	case err := <-second:
		close(release)
		<-first
		t.Fatalf("new request dropped while earlier check running: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-second:
		if err != nil || calls != 3 {
			t.Fatal("queued startup", err, calls)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("new startup never resumed")
	}
}
