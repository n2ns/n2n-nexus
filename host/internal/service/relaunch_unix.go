//go:build !windows

package service

import (
	"os"
	"syscall"
)

// Relaunch replaces a foreground host or tray after its database and listener close.
func Relaunch(exe string) error {
	return syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ())
}
