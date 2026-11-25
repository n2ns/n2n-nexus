package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func detachUpdateWorker(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP}
}

var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

const attachParentProcess = ^uintptr(0) // ATTACH_PARENT_PROCESS, (DWORD)-1

// attachConsole connects a windowsgui build's standard output and error to
// the console of the terminal that started it. Handles that are already set
// (redirected to a file or pipe) are kept.
func attachConsole() {
	stdout, _ := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	stderr, _ := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	unset := func(h windows.Handle) bool { return h == 0 || h == windows.InvalidHandle }
	if !unset(stdout) && !unset(stderr) {
		return
	}
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	con, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		return
	}
	if unset(stdout) {
		os.Stdout = con
		_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(con.Fd()))
	}
	if unset(stderr) {
		os.Stderr = con
		_ = windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(con.Fd()))
	}
}

// TrayExe is the GUI build shipped next to the console build on Windows: a
// console program cannot run without a console window, and a GUI program
// cannot make the terminal wait for its output, so commands use
// n2n-nexus-host.exe and the tray n2n-nexus-host-tray.exe.
const TrayExe = "n2n-nexus-host-tray.exe"

// trayExecutable is the program that runs the tray: the tray build next to
// self when there is one, else self.
func trayExecutable(self string) string {
	trayPath := filepath.Join(filepath.Dir(self), TrayExe)
	if _, err := os.Stat(trayPath); err == nil {
		return trayPath
	}
	return self
}

// launchTray starts the tray build next to this executable, if this is the
// console build and the tray build is there; it reports whether it did.
func launchTray(self string) bool {
	if strings.EqualFold(filepath.Base(self), TrayExe) {
		return false
	}
	trayPath := filepath.Join(filepath.Dir(self), TrayExe)
	if _, err := os.Stat(trayPath); err != nil {
		return false
	}
	cmd := exec.Command(trayPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		return false
	}
	_ = cmd.Process.Release()
	return true
}
