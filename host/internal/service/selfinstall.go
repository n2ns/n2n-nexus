package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
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

// ReplacePrograms copies names from srcDir to dstDir. A program already in
// dstDir is renamed to <name>.old first, which Windows allows while it runs,
// and a leftover .old from an earlier install that no longer runs is removed;
// one that still runs stays, and this rename gets a timestamped name instead.
func ReplacePrograms(srcDir, dstDir string, names []string) error {
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	for _, name := range names {
		dst := filepath.Join(dstDir, name)
		// Copy first, so a failed copy leaves the installed program in place.
		if err := copyFile(filepath.Join(srcDir, name), dst+".new"); err != nil {
			os.Remove(dst + ".new")
			return fmt.Errorf("copy %s: %w", name, err)
		}
		if err := os.Remove(dst + ".old"); err != nil && !errors.Is(err, fs.ErrNotExist) {
			// Still running (or locked): keep it, move the current one aside under another name.
			if err := moveAside(dst, dst+"."+strconv.FormatInt(time.Now().UnixNano(), 36)+".old"); err != nil {
				return err
			}
		} else if err := moveAside(dst, dst+".old"); err != nil {
			return err
		}
		if err := os.Rename(dst+".new", dst); err != nil {
			return err
		}
	}
	return nil
}

// moveAside renames file to aside when it exists.
func moveAside(file, aside string) error {
	if err := os.Rename(file, aside); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
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

// removeLeftovers deletes the .old programs of earlier installs that no longer run.
func removeLeftovers(dir string) {
	olds, _ := filepath.Glob(filepath.Join(dir, "*.old"))
	for _, old := range olds {
		_ = os.Remove(old)
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
