package service

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
)

func registeredServe() ([]string, error) {
	code, out, err := RunPowerShell(WindowsTaskActionScript())
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("read Windows host service: %s", strings.TrimSpace(out))
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
