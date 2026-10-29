package service

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func readFile(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReplacePrograms(t *testing.T) {
	src, dst := filepath.Join(t.TempDir(), "release"), filepath.Join(t.TempDir(), "Programs", "n2n-nexus-host")
	names := []string{"a.exe", "b.exe"}
	writeFiles(t, src, map[string]string{"a.exe": "a2", "b.exe": "b2"})

	// A first install creates the folder.
	if err := ReplacePrograms(src, dst, names); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "a2" {
		t.Fatal("not copied")
	}

	// An upgrade keeps the previous program as .old and replaces an earlier .old.
	writeFiles(t, dst, map[string]string{"a.exe.old": "a0"})
	writeFiles(t, src, map[string]string{"a.exe": "a3", "b.exe": "b3"})
	if err := ReplacePrograms(src, dst, names); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "a3" || readFile(t, filepath.Join(dst, "a.exe.old")) != "a2" || readFile(t, filepath.Join(dst, "b.exe.old")) != "b2" {
		t.Fatal("upgrade did not keep the previous programs as .old")
	}

	// Leftovers go; other files stay.
	writeFiles(t, dst, map[string]string{"settings.txt": "x"})
	removeLeftovers(dst)
	entries, _ := os.ReadDir(dst)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if !slices.Equal(left, []string{"a.exe", "b.exe", "settings.txt"}) {
		t.Fatalf("left %v", left)
	}
}

func TestReplaceProgramsNeedsTheRelease(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFiles(t, src, map[string]string{"a.exe": "a"})
	writeFiles(t, dst, map[string]string{"missing.exe": "installed"})
	if err := ReplacePrograms(src, dst, []string{"a.exe", "missing.exe"}); err == nil {
		t.Fatal("copied without missing.exe")
	}
	// A failed copy leaves the installed program in place.
	if readFile(t, filepath.Join(dst, "missing.exe")) != "installed" {
		t.Fatal("installed program lost")
	}
}

func TestReplaceProgramsKeepsARunningOld(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFiles(t, src, map[string]string{"a.exe": "new"})
	writeFiles(t, dst, map[string]string{"a.exe": "current"})
	// An .old that cannot be removed (here a non-empty folder; on Windows a running program).
	writeFiles(t, filepath.Join(dst, "a.exe.old"), map[string]string{"x": "running"})
	if err := ReplacePrograms(src, dst, []string{"a.exe"}); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "new" {
		t.Fatal("not replaced")
	}
	aside, _ := filepath.Glob(filepath.Join(dst, "a.exe.*.old"))
	if len(aside) != 1 || readFile(t, aside[0]) != "current" {
		t.Fatalf("current program not moved aside under a new name: %v", aside)
	}
}

func TestTaskRoot(t *testing.T) {
	for args, want := range map[string]string{
		WindowsTaskArgs(`D:\nexus data`, `D:\logs`): `D:\nexus data`,
		WindowsTaskArgs(`D:\`, `D:\logs`):           `D:\`,
		"serve --supervise":                         "",
		`serve --root "unterminated`:                "",
	} {
		if got := taskRoot(args); got != want {
			t.Errorf("taskRoot(%q) = %q, want %q", args, got, want)
		}
	}
}

// PowerShell 5.1 hands 'C:\x y\' to a program as C:\x y" (the \ escapes the quote it adds around a value with spaces).
func TestRootArg(t *testing.T) {
	for dir, want := range map[string]string{
		`D:\nexus data\`: `D:\nexus data\.`,
		`D:\`:            `D:\.`,
		`D:\nexus data`:  `D:\nexus data`,
		"":               "",
	} {
		if got := rootArg(dir); got != want {
			t.Errorf("rootArg(%q) = %q, want %q", dir, got, want)
		}
	}
}

func TestAutostartState(t *testing.T) {
	dir := `C:\Users\u\AppData\Local\Programs\n2n-nexus-host`
	for current, want := range map[string]int{
		"": autostartUnset,
		`"C:\Users\u\AppData\Local\Programs\n2n-nexus-host\n2n-nexus-host-tray.exe"`: autostartHere,
		`"c:\users\u\appdata\local\programs\N2N-NEXUS-HOST\n2n-nexus-host-tray.exe"`: autostartHere,
		`"C:\Users\u\scoop\apps\n2n-nexus-host\current\n2n-nexus-host-tray.exe"`:     autostartElsewhere,
	} {
		if got := autostartState(current, dir); got != want {
			t.Errorf("autostartState(%q) = %d, want %d", current, got, want)
		}
	}
	if autostartState(`"C:\x\tray.exe"`, `C:\x\`) != autostartHere {
		t.Error("a trailing separator on dir")
	}
}
