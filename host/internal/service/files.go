package service

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf16"
)

// Names of what install and autostart register.
const (
	TaskName         = "n2n-nexus-host" // Windows scheduled task
	RunValue         = "n2n-nexus-host" // Windows HKCU\...\Run value
	RunKey           = `Software\Microsoft\Windows\CurrentVersion\Run`
	DaemonLabel      = "io.n2ns.n2n-nexus-host" // macOS LaunchDaemon
	DaemonPlistPath  = "/Library/LaunchDaemons/" + DaemonLabel + ".plist"
	TrayLabel        = "io.n2ns.n2n-nexus-host.tray" // macOS LaunchAgent of the tray
	SystemdUnit      = "n2n-nexus-host.service"      // Linux
	SystemdUnitPath  = "/etc/systemd/system/" + SystemdUnit
	DesktopEntryName = "n2n-nexus-host.desktop" // Linux ~/.config/autostart
	NotElevatedExit  = 3                        // exit code of a PowerShell script run without administrator rights
	serviceLogName   = "service.log"            // launchd's stdout / stderr of the supervisor
)

// ServeArgs are the arguments every service runs the executable with: the
// installer's data and log directories, so the service's own environment
// cannot move them.
func ServeArgs(dataDir, logDir string) []string {
	return []string{"serve", "--supervise", "--root", dataDir, "--log-dir", logDir}
}

// ---- PowerShell (Windows) ----

// psQuote is a PowerShell single-quoted string literal.
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// EncodePowerShell is the -EncodedCommand form of script (UTF-16LE, base64).
func EncodePowerShell(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// PowerShellArgs are the powershell.exe arguments that run script.
func PowerShellArgs(script string) []string {
	return []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", EncodePowerShell(script)}
}

// psPreamble: text output in UTF-8, no progress records, every error as one line of text.
const psPreamble = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
trap { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }
`

// psRequireAdmin exits NotElevatedExit without administrator rights.
var psRequireAdmin = fmt.Sprintf(`$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit %d }
`, NotElevatedExit)

// WindowsCheckAdminScript only checks for administrator rights.
func WindowsCheckAdminScript() string { return psPreamble + psRequireAdmin }

// psStopTask stops the task if it is registered and waits for its instance to
// end: Stop-ScheduledTask returns before it has, and -MultipleInstances
// IgnoreNew would drop a start while it still runs.
var psStopTask = fmt.Sprintf(`if (Get-ScheduledTask -TaskName %[1]s -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName %[1]s
    for ($i = 0; $i -lt 40 -and (Get-ScheduledTask -TaskName %[1]s).State -eq "Running"; $i++) { Start-Sleep -Milliseconds 250 }
    if ((Get-ScheduledTask -TaskName %[1]s).State -eq "Running") { Write-Output "ERROR: the task's previous instance has not ended yet; run this command again."; exit 1 }
    Write-Output %[2]s
}
`, psQuote(TaskName), psQuote(`Stopped scheduled task "`+TaskName+`".`))

// WindowsTaskActionScript prints the program the scheduled task runs and,
// on the next line, its arguments; nothing when it is not registered.
func WindowsTaskActionScript() string {
	return psPreamble + fmt.Sprintf(`$task = Get-ScheduledTask -TaskName %s -ErrorAction SilentlyContinue
if ($task) { Write-Output $task.Actions[0].Execute; Write-Output $task.Actions[0].Arguments }
`, psQuote(TaskName))
}

// WindowsElevatedScript runs exe with args as administrator (Windows asks
// with a UAC prompt), waits for it, writes its output to outFile and exits
// with its exit code; declining the prompt is an error.
func WindowsElevatedScript(exe string, args []string, outFile string) string {
	quote := func(list []string, sep string) string {
		quoted := make([]string, len(list))
		for i, a := range list {
			quoted[i] = psQuote(a)
		}
		return strings.Join(quoted, sep)
	}
	// A new powershell.exe decodes the program's output with the OEM code page unless told otherwise.
	inner := fmt.Sprintf("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n& %s %s *>&1 | Out-File -Encoding utf8 %s\nexit $LASTEXITCODE\n", psQuote(exe), quote(args, " "), psQuote(outFile))
	return psPreamble + fmt.Sprintf(`$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList %s
exit $p.ExitCode
`, quote(PowerShellArgs(inner), ","))
}

// WindowsStopTaskScript stops a registered task and waits until its instance has ended.
func WindowsStopTaskScript() string { return psPreamble + psRequireAdmin + psStopTask }

// WindowsTaskArgs is the task action's argument string: serve --supervise --root "<dir>" --log-dir "<dir>".
// A trailing backslash would escape the closing quote, so it gets a "." appended.
func WindowsTaskArgs(dataDir, logDir string) string {
	quote := func(dir string) string {
		if strings.HasSuffix(dir, `\`) {
			dir += "."
		}
		return `"` + dir + `"`
	}
	return `serve --supervise --root ` + quote(dataDir) + ` --log-dir ` + quote(logDir)
}

// CheckWindowsPath rejects paths the task action cannot carry: Task Scheduler
// expands %VAR% in arguments, and a " cannot be quoted.
func CheckWindowsPath(what, path string) error {
	if strings.ContainsAny(path, `%"`) {
		return fmt.Errorf("%s %s: %% and \" are not supported in the path", what, path)
	}
	return nil
}

// WindowsRegisterScript registers the boot task (S4U principal of the current
// user, no time limit, IgnoreNew) and starts it.
func WindowsRegisterScript(exe, dataDir, logDir string) string {
	q := psQuote(TaskName)
	return psPreamble + psRequireAdmin + fmt.Sprintf(`$action = New-ScheduledTaskAction -Execute %s -Argument %s -WorkingDirectory %s
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName %s -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description %s -Force | Out-Null
Start-ScheduledTask -TaskName %s
Write-Output %s
`, psQuote(exe), psQuote(WindowsTaskArgs(dataDir, logDir)), psQuote(dataDir), q, psQuote("n2n-nexus host for "+dataDir), q,
		psQuote(`Registered and started scheduled task "`+TaskName+`" (starts at boot).`))
}

// WindowsUninstallScript stops and removes the task.
func WindowsUninstallScript() string {
	q := psQuote(TaskName)
	return psPreamble + psRequireAdmin + psStopTask + fmt.Sprintf(`if (Get-ScheduledTask -TaskName %s -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName %s -Confirm:$false
    Write-Output %s
} else {
    Write-Output %s
}
`, q, q, psQuote(`Removed scheduled task "`+TaskName+`".`), psQuote(`Scheduled task "`+TaskName+`" is not installed.`))
}

// WindowsStatusScript prints "installed <State>" or "not-installed".
func WindowsStatusScript() string {
	return psPreamble + fmt.Sprintf(`$task = Get-ScheduledTask -TaskName %s -ErrorAction SilentlyContinue
if ($task) { Write-Output "installed $($task.State)" } else { Write-Output "not-installed" }
`, psQuote(TaskName))
}

// WindowsPortOwnerScript prints "PID <pid>: <command line>" of the process listening on TCP port, or nothing.
func WindowsPortOwnerScript(port int) string {
	return psPreamble + fmt.Sprintf(`$listener = Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { exit 0 }
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
Write-Output "PID $($listener.OwningProcess): $($owner.CommandLine)"
`, port)
}

// FirewallRuleNames are the inbound rules LAN mode adds on Windows.
func FirewallRuleNames(port, discoveryPort int) (tcp, udp string) {
	return fmt.Sprintf("n2n-nexus-host TCP %d", port), fmt.Sprintf("n2n-nexus-host UDP %d (discovery)", discoveryPort)
}

// WindowsFirewallScript runs, elevated through a UAC prompt, netsh commands
// that (re)create inbound rules for TCP port and UDP discoveryPort. It exits 0
// once both rules exist, 1 when the prompt was declined or netsh failed.
func WindowsFirewallScript(port, discoveryPort int) string {
	tcp, udp := FirewallRuleNames(port, discoveryPort)
	inner := fmt.Sprintf(`netsh advfirewall firewall delete rule name="%[1]s" | Out-Null
netsh advfirewall firewall add rule name="%[1]s" dir=in action=allow protocol=TCP localport=%[2]d profile=private,domain | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
netsh advfirewall firewall delete rule name="%[3]s" | Out-Null
netsh advfirewall firewall add rule name="%[3]s" dir=in action=allow protocol=UDP localport=%[4]d profile=private,domain | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
exit 0
`, tcp, port, udp, discoveryPort)
	args := PowerShellArgs(inner)
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = psQuote(a)
	}
	return psPreamble + fmt.Sprintf(`$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList %s
exit $p.ExitCode
`, strings.Join(quoted, ","))
}

// ---- launchd (macOS) ----

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`

func plistArgs(args []string) string {
	var b strings.Builder
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range args {
		fmt.Fprintf(&b, "\t\t<string>%s</string>\n", xmlEscape(a))
	}
	b.WriteString("\t</array>\n")
	return b.String()
}

// LaunchDaemonPlist is /Library/LaunchDaemons/io.n2ns.n2n-nexus-host.plist:
// started at boot as user, kept alive, output in logDir/service.log.
func LaunchDaemonPlist(exe, dataDir, logDir, user, home string) string {
	logFile := xmlEscape(strings.TrimSuffix(logDir, "/") + "/" + serviceLogName)
	return plistHeader + fmt.Sprintf("\t<key>Label</key>\n\t<string>%s</string>\n\t<key>UserName</key>\n\t<string>%s</string>\n",
		DaemonLabel, xmlEscape(user)) +
		plistArgs(append([]string{exe}, ServeArgs(dataDir, logDir)...)) +
		fmt.Sprintf("\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>HOME</key>\n\t\t<string>%s</string>\n\t</dict>\n", xmlEscape(home)) +
		fmt.Sprintf("\t<key>WorkingDirectory</key>\n\t<string>%s</string>\n", xmlEscape(dataDir)) +
		"\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<true/>\n" +
		fmt.Sprintf("\t<key>StandardOutPath</key>\n\t<string>%[1]s</string>\n\t<key>StandardErrorPath</key>\n\t<string>%[1]s</string>\n", logFile) +
		"</dict>\n</plist>\n"
}

// TrayLaunchAgentPlist is ~/Library/LaunchAgents/io.n2ns.n2n-nexus-host.tray.plist: the tray at login.
func TrayLaunchAgentPlist(exe string) string {
	return plistHeader + fmt.Sprintf("\t<key>Label</key>\n\t<string>%s</string>\n", TrayLabel) +
		plistArgs([]string{exe}) +
		"\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n" +
		"</dict>\n</plist>\n"
}

// ---- systemd and XDG autostart (Linux) ----

// systemdQuote is one double-quoted systemd command-line word: C-style
// escapes for \ and ", %% for a literal % (specifier) and $$ for a literal $.
func systemdQuote(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(s)
	return `"` + s + `"`
}

// SystemdUnitFile is /etc/systemd/system/n2n-nexus-host.service.
func SystemdUnitFile(exe, dataDir, logDir, user string) string {
	words := []string{systemdQuote(exe)}
	for _, a := range ServeArgs(dataDir, logDir) {
		words = append(words, systemdQuote(a))
	}
	return fmt.Sprintf(`[Unit]
Description=n2n-nexus host
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=%s
WorkingDirectory=%s
ExecStart=%s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, user, strings.ReplaceAll(dataDir, "%", "%%"), strings.Join(words, " "))
}

// desktopExecQuote quotes one Exec argument of a desktop entry: inside double
// quotes ", `, $ and \ get a backslash, % is doubled, and the string value
// escaping then doubles every backslash again.
func desktopExecQuote(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`, "%", "%%").Replace(s)
	return `"` + strings.ReplaceAll(s, `\`, `\\`) + `"`
}

// DesktopEntry is ~/.config/autostart/n2n-nexus-host.desktop: the tray at login.
func DesktopEntry(exe string) string {
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=n2n-nexus host
Comment=n2n-nexus host in the system tray
Exec=%s
Terminal=false
X-GNOME-Autostart-enabled=true
`, desktopExecQuote(exe))
}

// WindowsRunValue is the HKCU Run value: the quoted executable (the tray).
func WindowsRunValue(exe string) string { return `"` + exe + `"` }
