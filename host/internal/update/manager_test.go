//go:build !windows

package update

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Simulate a tap refresh after info but before upgrade consumes the formula.
func TestBrewRefusesChangedRecipeBeforeInstall(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	os.Mkdir(bin, 0755)
	opt := filepath.Join(dir, "opt", "n2n-nexus-host")
	if err := os.MkdirAll(filepath.Join(opt, "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(opt, "bin", "n2n-nexus-host")
	os.WriteFile(exe, []byte("old"), 0700)
	digest := strings.Repeat("a", 64)
	script := `#!/bin/sh
echo "$1" >> "$BREW_TEST_PREFIX/calls"
case "$1" in
 --prefix) echo "$BREW_TEST_PREFIX";;
 info) echo '{"formulae":[{"full_name":"n2ns/tap/n2n-nexus-host","versions":{"stable":"1.2.3"},"options":[{"option":"--with-nexus-recipe-'` + digest + `'"}]}]}';;
 upgrade)
  for arg in "$@"; do
   case "$arg" in --with-nexus-recipe-*) exit 1;; esac
  done
  echo "wrong release" > "$BREW_TEST_PREFIX/bin/n2n-nexus-host";;
esac
`
	os.WriteFile(filepath.Join(bin, "brew"), []byte(script), 0700)
	t.Setenv("PATH", "/usr/bin:/bin") // launchd, without Homebrew
	t.Setenv("BREW_TEST_PREFIX", opt)
	if err := managerUpdate(t.Context(), "brew", exe, "1.2.3", io.Discard); err == nil {
		t.Fatal("changed recipe accepted")
	}
	calls, err := os.ReadFile(filepath.Join(opt, "calls"))
	if err != nil || string(calls) != "--prefix\nupdate\ninfo\nupgrade\n" {
		t.Fatalf("brew calls: %q, %v", calls, err)
	}
	contents, _ := os.ReadFile(exe)
	if string(contents) != "old" {
		t.Fatal("unchecked formula updated installation")
	}
}
