// Package program locates the stable executable of the current installation.
package program

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func Same(a, b string) bool {
	x, err := os.Stat(a)
	if err != nil {
		return false
	}
	y, err := os.Stat(b)
	return err == nil && os.SameFile(x, y)
}

// Stable preserves Homebrew's opt link and Scoop's current junction across upgrades.
// os.Executable can return the version-specific target even when started through a link.
func Stable(exe string) (path, method string) {
	absolute, err := filepath.Abs(exe)
	if err != nil {
		return exe, ""
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return absolute, ""
	}
	dir := filepath.Dir(resolved)
	if runtime.GOOS != "windows" {
		keg := filepath.Dir(dir)
		rack := filepath.Dir(keg)
		cellar := filepath.Dir(rack)
		if filepath.Base(cellar) == "Cellar" && filepath.Base(rack) == "n2n-nexus-host" {
			stable := filepath.Join(filepath.Dir(cellar), "opt", "n2n-nexus-host", "bin", filepath.Base(resolved))
			if Same(stable, resolved) {
				return stable, "brew"
			}
			return resolved, ""
		}
		if dir == "/usr/bin" || dir == "/bin" || strings.HasPrefix(resolved, "/nix/store/") || strings.HasPrefix(resolved, "/snap/") {
			return resolved, ""
		}
	} else {
		app := filepath.Dir(dir)
		if strings.EqualFold(filepath.Base(app), "n2n-nexus-host") && strings.EqualFold(filepath.Base(filepath.Dir(app)), "apps") {
			current := filepath.Join(app, "current", filepath.Base(resolved))
			if Same(current, resolved) {
				return current, "scoop"
			}
			return resolved, ""
		}
		if strings.Contains(strings.ToLower(resolved), `\winget\packages\`) {
			return resolved, ""
		}
	}
	return resolved, "archive"
}
func Console(exe string) string {
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Base(exe), "n2n-nexus-host-tray.exe") {
		return filepath.Join(filepath.Dir(exe), "n2n-nexus-host.exe")
	}
	return exe
}
