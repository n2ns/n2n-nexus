// Package program locates the stable executable of the current installation.
package program

import (
	"os"
	"os/exec"
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

// Invoked keeps the original launch link when a concurrent upgrade switches it
// after exec but before os.Executable is inspected. A deliberately launched
// old version or an unrelated installation must not take over the active one.
func Invoked(exe, argv0 string) (string, string) {
	original, method := Stable(exe)
	aside := strings.HasSuffix(original, ".old")
	if method != "" && !aside {
		return original, method
	}
	invoked, err := exec.LookPath(argv0)
	if err != nil {
		return original, method
	}
	active, manager := Stable(invoked)
	target, err := filepath.EvalSymlinks(active)
	if err != nil || target == original {
		return original, method
	}
	oldDir, newDir := filepath.Dir(original), filepath.Dir(target)
	name := filepath.Base(target)
	if manager == "archive" && aside && Same(oldDir, newDir) &&
		(name == "n2n-nexus-host" || name == "n2n-nexus-host.exe" || name == "n2n-nexus-host-tray.exe") &&
		strings.HasPrefix(filepath.Base(original), name+".") {
		return active, manager
	}
	if filepath.Base(original) != name {
		return original, method
	}
	switch manager {
	case "brew":
		if filepath.Base(oldDir) != "bin" || filepath.Base(newDir) != "bin" {
			return original, method
		}
		oldDir, newDir = filepath.Dir(oldDir), filepath.Dir(newDir)
	case "scoop":
	default:
		return original, method
	}
	if Same(filepath.Dir(oldDir), filepath.Dir(newDir)) {
		return active, manager
	}
	return original, method
}

func Console(exe string) string {
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Base(exe), "n2n-nexus-host-tray.exe") {
		return filepath.Join(filepath.Dir(exe), "n2n-nexus-host.exe")
	}
	return exe
}
