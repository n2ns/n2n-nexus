package service

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

func TestUpdateFindsMatchingRegisteredServiceRoot(t *testing.T) {
	dir := t.TempDir()
	saved := unitPath
	unitPath = filepath.Join(dir, "host.service")
	t.Cleanup(func() { unitPath = saved })
	t.Setenv("NEXUS_ROOT", "")
	exe := filepath.Join(dir, "host executable")
	if err := os.WriteFile(exe, []byte{}, 0700); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other host")
	if err := os.WriteFile(other, []byte{}, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, `root $12 %h "test" path\x`)
	if err := os.WriteFile(unitPath, []byte(SystemdUnitFile(exe, root, dir, "owner")), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := UpdateRoot(exe); err != nil || got != root {
		t.Fatalf("registered root = %q, %v", got, err)
	}
	if got, err := UpdateRoot(other); err != nil || got != config.DataDir() {
		t.Fatalf("other installation = %q, %v", got, err)
	}
	t.Setenv("NEXUS_ROOT", dir)
	if got, err := UpdateRoot(exe); err != nil || got != dir {
		t.Fatalf("environment = %q, %v", got, err)
	}
}
