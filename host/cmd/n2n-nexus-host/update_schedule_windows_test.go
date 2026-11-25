//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/n2ns/n2n-nexus/autoupdate"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

func TestWindowsUpdateJob(t *testing.T) {
	// Create real Task Scheduler definitions but never register a task on the test machine.
	t.Setenv("LOCALAPPDATA", t.TempDir())
	// Importing ScheduledTasks for the real New-* constructors can shadow same-name
	// mocks. Give every command that reads or writes registered jobs a test-only name.
	schedule := strings.NewReplacer(
		"Get-ScheduledTask", "Get-FixtureTask",
		"Register-ScheduledTask", "Register-FixtureTask",
		"Unregister-ScheduledTask", "Unregister-FixtureTask",
	).Replace(autoupdate.Windows)
	script := `
$ErrorActionPreference = 'Stop'
function Get-FixtureTask {
    if ($script:offline) { throw 'Task Scheduler unavailable' }
    if ($script:task) { [pscustomobject]@{TaskName=$script:task;State='Ready'} }
}
function Register-FixtureTask {
    param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force)
    if ($Principal.LogonType -ne 'Interactive' -or $Principal.RunLevel -ne 'Limited') { throw 'Unexpected update job privileges' }
    $script:task = $TaskName
}
function Unregister-FixtureTask { $script:task = $null }
$probe = Join-Path $env:LOCALAPPDATA 'test command.ps1'
[IO.File]::WriteAllText($probe, 'if ($args[0] -ne "Abc '' q" -or $env:PI_CODING_AGENT_DIR -ne "x y") { exit 7 }; exit 0')
$exe = Join-Path $PSHOME powershell.exe
$file = Join-Path $env:LOCALAPPDATA 'n2n-nexus\updates\host.ps1'
$env:PI_CODING_AGENT_DIR = 'x y'
foreach ($verb in 'on','on','off','off') {
    $env:N2N_NEXUS_UPDATE_SCHEDULE = ConvertTo-Json -Compress @{component='host';action=$verb;argv=@($exe,'-NoProfile','-ExecutionPolicy','Bypass','-File',$probe,"Abc ' q")}
    try { & { ` + schedule + ` } } catch {
        if (-not $script:offline -or $_.Exception.Message -ne 'Task Scheduler unavailable') { throw }
    }
    if ($verb -eq 'on') {
        & $exe -NoProfile -ExecutionPolicy Bypass -File $file
        if ($LASTEXITCODE) { throw "Runner failed ($LASTEXITCODE)" }
        $script:offline = $true
    } elseif ($script:offline) {
        if ((Test-Path $file) -or -not (Test-Path (Join-Path (Split-Path $file) 'host-removal-pending'))) { throw 'Failed disable left a runnable task' }
        $script:offline = $false
    }
}
if ($script:task -or (Test-Path $file) -or (Test-Path (Join-Path (Split-Path $file) 'host-removal-pending'))) { throw 'Pending task still present after off' }
`
	shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if out, err := exec.Command(shell, service.PowerShellArgs(script)...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}
