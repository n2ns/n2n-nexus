//go:build !windows

package main

import (
	"log"
	"os/exec"
	"syscall"
)

// A terminal hangup or foreground interrupt must not interrupt a binary replacement.
func detachUpdateWorker(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// attachConsole is needed only for the windowsgui build.
func attachConsole() {}

// trayExecutable: only Windows ships a separate tray build.
func trayExecutable(self string) string { return self }

// launchTray: only Windows ships a separate tray build.
func launchTray(string) bool { return false }

func dispatchServiceUpdate(int) bool               { return false }
func trayServiceUpdateRecovery() func(*log.Logger) { return nil }
func serviceUpdateCommand([]string) int            { return 2 }
