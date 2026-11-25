package service

import (
	"regexp"
	"strings"
	"testing"
)

// Create in-memory CIM definitions with the real Windows cmdlets, replacing
// every Task Scheduler lookup, registration and start with isolated functions.
func TestInteractiveTaskWithWindowsPowerShell(t *testing.T) {
	const exe = `C:\Example O'Brien\n2n-nexus-host-tray.exe`
	mocks := `$PSModuleAutoLoadingPreference='None'
Import-Module Microsoft.PowerShell.Utility,ScheduledTasks -ErrorAction Stop
$global:simulatedTask=$null
$global:registrations=0
$global:starts=0
function Get-NexusFixtureRecord { param($TaskPath,$TaskName,$ErrorAction); if ($TaskPath -ne '\' -or $TaskName -ne 'n2n-nexus-host-startup-update') { throw 'wrong lookup scope' }; return $global:simulatedTask }
function Register-NexusFixtureRecord {
 param($TaskPath,$TaskName,$Action,$Principal,$Trigger,$Settings,[switch]$Force)
 if ($TaskPath -ne '\' -or $TaskName -ne 'n2n-nexus-host-startup-update') { throw 'wrong registration scope' }
 if ($Principal.RunLevel -ne 'Limited' -or $Principal.LogonType -ne 'Interactive' -or $Principal.UserId -ne [Security.Principal.WindowsIdentity]::GetCurrent().Name) { throw 'wrong user token' }
 if ($Trigger.CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or $Trigger.UserId -ne $Principal.UserId -or $Settings.MultipleInstances -ne 'Queue') { throw 'wrong trigger or queue mode' }
 if ($Action.Execute -ne 'C:\Example O''Brien\n2n-nexus-host-tray.exe' -or $Action.Arguments -ne 'auto-update service-login') { throw 'wrong action' }
 $global:registrations++
 $global:simulatedTask=[pscustomobject]@{Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings}
}
function Start-NexusFixtureRecord { param($TaskPath,$TaskName); if ($TaskPath -ne '\' -or $TaskName -ne 'n2n-nexus-host-startup-update') { throw 'wrong start scope' }; $global:starts++ }
`
	fixture := strings.NewReplacer("Get-ScheduledTask ", "Get-NexusFixtureRecord ", "Register-ScheduledTask ", "Register-NexusFixtureRecord ", "Start-ScheduledTask ", "Start-NexusFixtureRecord ").Replace(WindowsInteractiveUpdateScript(exe))
	script := mocks + fixture + fixture + `
if ($registrations -ne 1 -or $starts -ne 2) { throw "registered $registrations times, started $starts times" }
Write-Output 'verified mock logon and queued service restart'
`
	if regexp.MustCompile(`(?i)\b(?:Get|Register|Start|Stop|Set|Enable|Disable|Unregister)-ScheduledTask\b`).MatchString(script) {
		t.Fatal("test contains a live Task Scheduler operation")
	}
	code, out, err := RunPowerShell(script)
	if err != nil || code != 0 || !strings.Contains(out, "verified mock logon") {
		t.Fatalf("code %d: %v %s", code, err, out)
	}
}
