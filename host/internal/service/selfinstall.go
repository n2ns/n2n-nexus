package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// SelfInstallOptions are the flags of `install`.
type SelfInstallOptions struct {
	// Exe is the running console build; the programs next to it are installed.
	Exe string
	// Dir is where to install, "" for DefaultInstallDir.
	Dir string
	Out io.Writer
}

// Programs `install` copies on Windows: the console build and the tray build.
var installedPrograms = []string{"n2n-nexus-host.exe", "n2n-nexus-host-tray.exe"}

// ReplacePrograms copies names from srcDir to dstDir, all of them or none:
// the programs of one release work together. A program already in dstDir is
// renamed to <name>.old first, which Windows allows while it runs, and a
// leftover .old from an earlier install that no longer runs is removed; one
// that still runs stays, and this rename gets a timestamped name instead.
func ReplacePrograms(srcDir, dstDir string, names []string) error {
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	defer func() {
		for _, name := range names {
			os.Remove(filepath.Join(dstDir, name) + ".new")
		}
	}()
	// Copy all of them first, so a failed copy leaves the installed programs in place.
	for _, name := range names {
		if err := copyFile(filepath.Join(srcDir, name), filepath.Join(dstDir, name)+".new"); err != nil {
			return fmt.Errorf("copy %s: %w", name, err)
		}
	}
	// Then put them in place; when one cannot be, the ones already replaced are put back.
	type replaced struct{ dst, aside string } // aside "": no program was installed under dst
	var done []replaced
	for _, name := range names {
		dst := filepath.Join(dstDir, name)
		aside := dst + ".old"
		if err := os.Remove(aside); err != nil && !errors.Is(err, fs.ErrNotExist) {
			// Still running (or locked): keep it, move the current one aside under another name.
			aside = dst + "." + strconv.FormatInt(time.Now().UnixNano(), 36) + ".old"
		}
		moved, err := moveAside(dst, aside)
		if err == nil {
			if !moved {
				aside = ""
			}
			done = append(done, replaced{dst, aside})
			err = renameFile(dst+".new", dst)
		}
		if err != nil {
			for _, r := range slices.Backward(done) {
				if r.aside == "" {
					os.Remove(r.dst)
				} else {
					os.Rename(r.aside, r.dst)
				}
			}
			return err
		}
	}
	return nil
}

// renameFile puts a copied program in place; tests replace it.
var renameFile = os.Rename

// moveAside renames file to aside and reports whether file existed.
func moveAside(file, aside string) (bool, error) {
	err := os.Rename(file, aside)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// removeLeftovers deletes the .old programs of earlier installs that no longer
// run: <program>.old and <program>.<time>.old (see ReplacePrograms), nothing else in dir.
func removeLeftovers(dir string) {
	for _, name := range installedPrograms {
		olds, _ := filepath.Glob(filepath.Join(dir, name+".*.old"))
		for _, old := range append(olds, filepath.Join(dir, name+".old")) {
			_ = os.Remove(old)
		}
	}
}

// taskRoot is the --root of a scheduled task's arguments (WindowsTaskArgs),
// "" when there is none.
func taskRoot(args string) string {
	_, rest, ok := strings.Cut(args, `--root "`)
	if !ok {
		return ""
	}
	dir, _, ok := strings.Cut(rest, `"`)
	if !ok {
		return ""
	}
	// WindowsTaskArgs writes a directory ending in \ as \. (a \ before " escapes it).
	return strings.TrimSuffix(dir, ".")
}

// rootArg is a --root value as PowerShell can hand it to a program: it quotes
// a value with spaces, and a trailing \ would escape that quote, so the
// directory ends in \. instead, as in the task's arguments.
func rootArg(dir string) string {
	if strings.HasSuffix(dir, `\`) {
		return dir + "."
	}
	return dir
}

// Start at login, as `install` finds it.
const (
	autostartUnset     = iota // not set: on for a first install, else left off
	autostartHere             // runs this installation's tray: refreshed
	autostartElsewhere        // runs another copy: left alone
)

// autostartState classifies the Run value current (a quoted program path) for an installation in dir.
func autostartState(current, dir string) int {
	program := strings.Trim(current, `"`)
	if program == "" {
		return autostartUnset
	}
	parent := ""
	if i := strings.LastIndexAny(program, `\/`); i >= 0 {
		parent = program[:i]
	}
	if strings.EqualFold(strings.TrimRight(parent, `\/`), strings.TrimRight(dir, `\/`)) {
		return autostartHere
	}
	return autostartElsewhere
}
