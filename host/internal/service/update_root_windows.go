package service

import (
	"strings"

	"golang.org/x/sys/windows"
)

func registeredServe() ([]string, error) {
	_, out, err := RunPowerShell(WindowsTaskActionScript())
	if err != nil {
		return nil, err
	}
	exe, args, _ := strings.Cut(strings.TrimSpace(out), "\n")
	if exe == "" {
		return nil, nil
	}
	words, err := windows.DecomposeCommandLine(strings.TrimSpace(args))
	if err != nil {
		return nil, err
	}
	return append([]string{strings.TrimSpace(exe)}, words...), nil
}
