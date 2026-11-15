package service

import (
	"errors"
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

}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// The leftovers of the installed programs go; every other file of the folder
// stays, whatever its name: --dir may name a folder with files of the user's.
func TestRemoveLeftoversOnlyOfThePrograms(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"n2n-nexus-host.exe": "x", "n2n-nexus-host.exe.old": "x", "n2n-nexus-host.exe.lx2k9.old": "x", "n2n-nexus-host-tray.exe.old": "x",
		"hosts.old": "the user's", "settings.txt": "x",
	})
	removeLeftovers(dir)
	if left := dirNames(t, dir); !slices.Equal(left, []string{"hosts.old", "n2n-nexus-host.exe", "settings.txt"}) {
		t.Fatalf("left %v", left)
	}
}

func TestReplaceProgramsNeedsTheRelease(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFiles(t, src, map[string]string{"a.exe": "a"})
	writeFiles(t, dst, map[string]string{"a.exe": "installed a", "missing.exe": "installed"})
	if err := ReplacePrograms(src, dst, []string{"a.exe", "missing.exe"}); err == nil {
		t.Fatal("copied without missing.exe")
	}
	// A failed copy leaves every installed program in place: the folder never holds two versions.
	if readFile(t, filepath.Join(dst, "a.exe")) != "installed a" || readFile(t, filepath.Join(dst, "missing.exe")) != "installed" {
		t.Fatal("an installed program was replaced or lost")
	}
	if left := dirNames(t, dst); !slices.Equal(left, []string{"a.exe", "missing.exe"}) {
		t.Fatalf("left %v", left)
	}
}

// A program that cannot be put in place puts back the ones already replaced.
func TestReplaceProgramsRestoresOnAFailedRename(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFiles(t, src, map[string]string{"a.exe": "a2", "b.exe": "b2", "c.exe": "c2"})
	writeFiles(t, dst, map[string]string{"a.exe": "a1", "b.exe": "b1"})
	renameFile = func(from, to string) error {
		if to == filepath.Join(dst, "b.exe") {
			return errors.New("locked")
		}
		return os.Rename(from, to)
	}
	t.Cleanup(func() { renameFile = os.Rename })
	// c.exe is new in this release: nothing of it stays either.
	if err := ReplacePrograms(src, dst, []string{"c.exe", "a.exe", "b.exe"}); err == nil || err.Error() != "locked" {
		t.Fatalf("err %v", err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "a1" || readFile(t, filepath.Join(dst, "b.exe")) != "b1" {
		t.Fatal("the installed programs were not put back")
	}
	if left := dirNames(t, dst); !slices.Equal(left, []string{"a.exe", "b.exe"}) {
		t.Fatalf("left %v", left)
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
