//go:build windows

package service

import (
	"os"
	"os/exec"
)

// Start the replacement on the same standard handles, then let the old program exit.
func Relaunch(exe string) error {
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
