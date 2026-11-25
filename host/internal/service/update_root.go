package service

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/program"
)

// UpdateRoot locates the data of the installed service that launches this exact
// executable. An explicit --root is handled by the caller and NEXUS_ROOT wins.
func UpdateRoot(exe string) (string, error) {
	if dir := os.Getenv("NEXUS_ROOT"); dir != "" {
		return dir, nil
	}
	cmd, err := registeredServe()
	if err != nil {
		return "", err
	}
	if len(cmd) == 0 || !program.Same(cmd[0], exe) {
		return config.DataDir(), nil
	}
	i := slices.Index(cmd, "--root")
	if i < 1 || i+1 >= len(cmd) || !filepath.IsAbs(cmd[i+1]) {
		return "", fmt.Errorf("cannot read the registered service's --root; specify --root")
	}
	return cmd[i+1], nil
}
