//go:build !windows

package program

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInvokedAfterBrewLinkSwitch(t *testing.T) {
	const name = "n2n-nexus-host"
	makeKeg := func(prefix, version string) string {
		t.Helper()
		dir := filepath.Join(prefix, "Cellar", name, version, "bin")
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		exe := filepath.Join(dir, name)
		if err := os.WriteFile(exe, nil, 0755); err != nil {
			t.Fatal(err)
		}
		return exe
	}
	linkKeg := func(prefix, exe string) string {
		t.Helper()
		opt := filepath.Join(prefix, "opt")
		if err := os.MkdirAll(opt, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Dir(filepath.Dir(exe)), filepath.Join(opt, name)); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(opt, name, "bin", name)
	}
	prefix, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := makeKeg(prefix, "1.0.0")
	active := linkKeg(prefix, makeKeg(prefix, "1.0.1"))
	foreign := t.TempDir()
	other := linkKeg(foreign, makeKeg(foreign, "1.0.1"))
	for _, tc := range []struct{ invoked, want, manager string }{
		{active, active, "brew"},
		{old, old, ""},
		{other, old, ""},
	} {
		got, manager := Invoked(old, tc.invoked)
		if got != tc.want || manager != tc.manager {
			t.Errorf("Invoked(%q, %q) = %q, %q; want %q, %q", old, tc.invoked, got, manager, tc.want, tc.manager)
		}
	}
}
