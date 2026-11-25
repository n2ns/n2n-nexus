package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/n2ns/n2n-nexus/host/internal/program"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

var recipeOption = regexp.MustCompile(`^--with-nexus-recipe-([a-f0-9]{64})$`)

const formula = "n2ns/tap/n2n-nexus-host"

func managerUpdate(ctx context.Context, method, exe, v string, out io.Writer) error {
	if method == "scoop" {
		// The version comes exclusively from a validated numeric stable release
		// tag. Scoop's versioned install switches the current junction to that
		// exact version without uninstalling a running executable first.
		script := `$ErrorActionPreference='Stop'
$prefix=(scoop prefix n2n-nexus-host | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath "$prefix/n2n-nexus-host.exe")) { throw 'Scoop installation not found' }
[Console]::WriteLine((Get-Item -LiteralPath "$prefix/n2n-nexus-host.exe").FullName)
`
		output, err := exec.CommandContext(ctx, "powershell.exe", service.PowerShellArgs("[Console]::OutputEncoding=[Text.Encoding]::UTF8\n"+script)...).Output()
		if err != nil {
			return fmt.Errorf("scoop prefix: %w", err)
		}
		if !program.Same(strings.TrimSpace(string(output)), exe) {
			return fmt.Errorf("Scoop manages another installation than %s", exe)
		}
		cmd := exec.CommandContext(ctx, "powershell.exe", service.PowerShellArgs("scoop install n2ns/n2n-nexus-host@"+v+"; exit $LASTEXITCODE")...)
		cmd.Stdout, cmd.Stderr = out, out
		return cmd.Run()
	}
	// program.Stable identified <prefix>/opt/n2n-nexus-host/bin/<exe>.
	// launchd need not put that Homebrew installation (or any brew) on PATH.
	brew := filepath.Join(filepath.Dir(exe), "../../..", "bin", "brew")
	prefix, err := exec.CommandContext(ctx, brew, "--prefix", formula).Output()
	if err != nil {
		return fmt.Errorf("brew --prefix: %w", err)
	}
	if !program.Same(filepath.Join(strings.TrimSpace(string(prefix)), "bin", "n2n-nexus-host"), exe) {
		return fmt.Errorf("Homebrew manages another installation than %s", exe)
	}
	// Refresh the tap before checking the candidate, then prevent a second
	// automatic tap refresh between the version check and the upgrade.
	refresh := exec.CommandContext(ctx, brew, "update", "--quiet")
	refresh.Stdout, refresh.Stderr = out, out
	if err = refresh.Run(); err != nil {
		return fmt.Errorf("brew update: %w", err)
	}
	env := append(os.Environ(), "HOMEBREW_NO_AUTO_UPDATE=1", "HOMEBREW_NO_INSTALL_UPGRADE=1", "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1", "HOMEBREW_NO_INSTALL_CLEANUP=1")
	probe := exec.CommandContext(ctx, brew, "info", "--json=v2", formula)
	probe.Env = env
	data, err := probe.Output()
	if err != nil {
		return err
	}
	var info struct {
		Formulae []struct {
			FullName string `json:"full_name"`
			Versions struct{ Stable string }
			Pinned   bool
			Options  []struct{ Option string }
		}
	}
	if err = json.Unmarshal(data, &info); err != nil {
		return err
	}
	if len(info.Formulae) != 1 || info.Formulae[0].FullName != formula || info.Formulae[0].Versions.Stable != v || info.Formulae[0].Pinned {
		return fmt.Errorf("Homebrew does not offer unpinned %s %s", formula, v)
	}
	// Homebrew accepts options declared by the named formula. Bind the option
	// read alongside the stable version to this invocation. A changed recipe
	// rejects the old flag; a change after argument parsing also fails inside
	// install before Go builds anything. Keep the tap's original formula name.
	var id string
	for _, option := range info.Formulae[0].Options {
		if m := recipeOption.FindStringSubmatch(option.Option); m != nil {
			id = m[1]
			break
		}
	}
	if id == "" {
		return fmt.Errorf("Homebrew formula %s lacks a release recipe identifier", v)
	}
	cmd := exec.CommandContext(ctx, brew, "upgrade", "--formula", "--build-from-source", "--with-nexus-recipe-"+id, formula)
	cmd.Env = append(env, "N2N_NEXUS_BREW_RECIPE="+id)
	cmd.Stdout, cmd.Stderr = out, out
	return cmd.Run()
}
