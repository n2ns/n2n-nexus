package service

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

func registeredServe() ([]string, error) {
	raw, err := os.ReadFile(unitPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		value, ok := strings.CutPrefix(line, "ExecStart=")
		if !ok {
			continue
		}
		var argv []string
		// SystemdUnitFile quotes every word, escapes quotes/backslashes and
		// doubles literal % and $ for systemd's specifier and variable expansion.
		for value = strings.TrimSpace(value); value != ""; value = strings.TrimSpace(value) {
			word, err := strconv.QuotedPrefix(value)
			if err != nil {
				return nil, fmt.Errorf("read ExecStart: %w", err)
			}
			arg, err := strconv.Unquote(word)
			if err != nil {
				return nil, err
			}
			argv = append(argv, strings.NewReplacer("%%", "%", "$$", "$").Replace(arg))
			value = value[len(word):]
		}
		return argv, nil
	}
	return nil, fmt.Errorf("no ExecStart in %s", unitPath)
}
