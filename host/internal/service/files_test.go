package service

import (
	"encoding/base64"
	"encoding/xml"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func decodePS(t *testing.T, b64 string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("bad -EncodedCommand: %v", err)
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	return string(utf16.Decode(u))
}

func mustContain(t *testing.T, s string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(s, p) {
			t.Errorf("missing %q in:\n%s", p, s)
		}
	}
}

func TestEncodePowerShellRoundTrips(t *testing.T) {
	script := "Write-Output 'Grüße 你好'"
	if got := decodePS(t, EncodePowerShell(script)); got != script {
		t.Fatalf("got %q", got)
	}
	args := PowerShellArgs(script)
	if strings.Join(args[:5], " ") != "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand" {
		t.Fatal(args)
	}
}

func TestWindowsRegisterScript(t *testing.T) {
	exe := `C:\Users\O'Brien\bin\n2n-nexus-host.exe`
	dir := `C:\Users\O'Brien\AppData\Local\n2n-nexus`
	s := WindowsRegisterScript(exe, dir, dir+`\logs`)
	mustContain(t, s,
		"exit 3", // not elevated
		`$ProgressPreference = "SilentlyContinue"`,
		`-Execute 'C:\Users\O''Brien\bin\n2n-nexus-host.exe'`,
		`-Argument 'serve --supervise --root "C:\Users\O''Brien\AppData\Local\n2n-nexus" --log-dir "C:\Users\O''Brien\AppData\Local\n2n-nexus\logs"'`,
		`-WorkingDirectory 'C:\Users\O''Brien\AppData\Local\n2n-nexus'`,
		"New-ScheduledTaskTrigger -AtStartup",
		"-LogonType S4U",
		"[Security.Principal.WindowsIdentity]::GetCurrent().Name",
		"-ExecutionTimeLimit ([TimeSpan]::Zero)",
		"-MultipleInstances IgnoreNew",
		"Register-ScheduledTask -TaskName 'n2n-nexus-host'",
		"Start-ScheduledTask -TaskName 'n2n-nexus-host'",
	)
	if strings.Index(s, "Register-ScheduledTask") > strings.Index(s, "Start-ScheduledTask") {
		t.Error("starts before registering")
	}
	if WindowsTaskArgs(`D:\`, `E:\`) != `serve --supervise --root "D:\." --log-dir "E:\."` {
		t.Error("a trailing backslash must not escape the closing quote:", WindowsTaskArgs(`D:\`, `E:\`))
	}
	if CheckWindowsPath("--root", `C:\%TEMP%\x`) == nil || CheckWindowsPath("--root", `C:\a"b`) == nil || CheckWindowsPath("--root", dir) != nil {
		t.Error("CheckWindowsPath")
	}
}

func TestWindowsStopAndUninstallScripts(t *testing.T) {
	stop := WindowsStopTaskScript()
	mustContain(t, stop, "exit 3", "Stop-ScheduledTask -TaskName 'n2n-nexus-host'", `.State -eq "Running"`, "Start-Sleep -Milliseconds 250")
	un := WindowsUninstallScript()
	mustContain(t, un, "exit 3", "Stop-ScheduledTask -TaskName 'n2n-nexus-host'", "Unregister-ScheduledTask -TaskName 'n2n-nexus-host' -Confirm:$false")
	if strings.Index(un, "Stop-ScheduledTask") > strings.Index(un, "Unregister-ScheduledTask") {
		t.Error("unregisters before stopping")
	}
	for _, s := range []string{stop, un, WindowsStatusScript(), WindowsPortOwnerScript(5688)} {
		// Processes are never matched by name or command line.
		if strings.Contains(s, "Stop-Process") || strings.Contains(s, "-match") || strings.Contains(s, "-like") {
			t.Errorf("script matches processes:\n%s", s)
		}
	}
	if strings.Contains(WindowsStatusScript(), "exit 3") {
		t.Error("status must not need elevation")
	}
	mustContain(t, WindowsPortOwnerScript(5799), "Get-NetTCPConnection -LocalPort 5799 -State Listen", "Win32_Process")
}

func TestWindowsFirewallScript(t *testing.T) {
	s := WindowsFirewallScript(5799, 5800)
	mustContain(t, s, "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru", "exit $p.ExitCode")
	i := strings.Index(s, "'-EncodedCommand','")
	if i < 0 {
		t.Fatal(s)
	}
	b64 := s[i+len("'-EncodedCommand','"):]
	b64 = b64[:strings.Index(b64, "'")]
	inner := decodePS(t, b64)
	mustContain(t, inner,
		`netsh advfirewall firewall add rule name="n2n-nexus-host TCP 5799" dir=in action=allow protocol=TCP localport=5799 profile=private,domain`,
		`netsh advfirewall firewall add rule name="n2n-nexus-host UDP 5800 (discovery)" dir=in action=allow protocol=UDP localport=5800 profile=private,domain`,
		`netsh advfirewall firewall delete rule name="n2n-nexus-host TCP 5799"`,
	)
}

func TestWindowsInstallScripts(t *testing.T) {
	mustContain(t, WindowsTaskActionScript(), "Get-ScheduledTask -TaskName 'n2n-nexus-host'", "$task.Actions[0].Execute", "$task.Actions[0].Arguments")
	s := WindowsElevatedScript(`C:\Program's\n2n-nexus-host.exe`, []string{"service", "install"}, `C:\Temp\out.log`)
	mustContain(t, s, "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru", "exit $p.ExitCode")
	i := strings.Index(s, "'-EncodedCommand','")
	if i < 0 {
		t.Fatal(s)
	}
	b64 := s[i+len("'-EncodedCommand','"):]
	inner := decodePS(t, b64[:strings.Index(b64, "'")])
	mustContain(t, inner, "[Console]::OutputEncoding = [Text.Encoding]::UTF8", `& 'C:\Program''s\n2n-nexus-host.exe' 'service' 'install' *>&1 | Out-File -Encoding utf8 'C:\Temp\out.log'`, "exit $LASTEXITCODE")
}

// plistStrings parses a plist and returns its <string> values in order.
func plistStrings(t *testing.T, s string) []string {
	t.Helper()
	d := xml.NewDecoder(strings.NewReader(s))
	d.Strict = true
	var out []string
	inString := false
	for {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch v := tok.(type) {
		case xml.StartElement:
			inString = v.Name.Local == "string"
		case xml.CharData:
			if inString {
				out = append(out, string(v))
			}
		case xml.EndElement:
			inString = false
		}
	}
	return out
}

func TestLaunchDaemonPlist(t *testing.T) {
	s := LaunchDaemonPlist("/opt/n2n & co/n2n-nexus-host", "/Users/ann/Library/Application Support/n2n-nexus", "/Users/ann/Library/Logs/n2n-nexus", "ann", "/Users/ann")
	mustContain(t, s, "<key>UserName</key>\n\t<string>ann</string>", "<key>KeepAlive</key>\n\t<true/>", "<key>RunAtLoad</key>\n\t<true/>",
		"<string>io.n2ns.n2n-nexus-host</string>", "&amp; co")
	got := plistStrings(t, s)
	want := []string{"io.n2ns.n2n-nexus-host", "ann", "/opt/n2n & co/n2n-nexus-host", "serve", "--supervise", "--root",
		"/Users/ann/Library/Application Support/n2n-nexus", "--log-dir", "/Users/ann/Library/Logs/n2n-nexus", "/Users/ann", "/Users/ann/Library/Application Support/n2n-nexus",
		"/Users/ann/Library/Logs/n2n-nexus/service.log", "/Users/ann/Library/Logs/n2n-nexus/service.log"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("strings\n got %q\nwant %q", got, want)
	}
}

func TestTrayLaunchAgentPlist(t *testing.T) {
	s := TrayLaunchAgentPlist("/Applications/n2n/n2n-nexus-host")
	mustContain(t, s, "<key>RunAtLoad</key>\n\t<true/>")
	if got := plistStrings(t, s); strings.Join(got, "|") != "io.n2ns.n2n-nexus-host.tray|/Applications/n2n/n2n-nexus-host|Aqua" {
		t.Fatal(got)
	}
	if strings.Contains(s, "KeepAlive") {
		t.Error("the tray must stay quit when the user quits it")
	}
}

func TestSystemdUnit(t *testing.T) {
	s := SystemdUnitFile("/home/ann/bin/n2n host", "/home/ann/.local/share/n2n-nexus 100%", "/home/ann/.local/state/n2n-nexus", "ann")
	mustContain(t, s,
		"User=ann\n", "Restart=always\n", "RestartSec=5\n", "WantedBy=multi-user.target\n",
		`ExecStart="/home/ann/bin/n2n host" "serve" "--supervise" "--root" "/home/ann/.local/share/n2n-nexus 100%%" "--log-dir" "/home/ann/.local/state/n2n-nexus"`+"\n",
		"WorkingDirectory=/home/ann/.local/share/n2n-nexus 100%%\n",
	)
	if q := systemdQuote(`a"b\c$d`); q != `"a\"b\\c$$d"` {
		t.Fatal(q)
	}
}

func TestDesktopEntry(t *testing.T) {
	s := DesktopEntry(`/home/ann/my apps/n2n-nexus-host`)
	mustContain(t, s, "[Desktop Entry]\n", "Type=Application\n", `Exec="/home/ann/my apps/n2n-nexus-host"`+"\n", "X-GNOME-Autostart-enabled=true\n")
	// A backslash is escaped for the Exec quoting, then again for the string value.
	if q := desktopExecQuote(`a\b$c%d`); q != `"a\\\\b\\$c%%d"` {
		t.Fatal(q)
	}
	if WindowsRunValue(`C:\Program Files\n2n\n2n-nexus-host.exe`) != `"C:\Program Files\n2n\n2n-nexus-host.exe"` {
		t.Fatal("run value must be quoted")
	}
}

func TestAutostartPaths(t *testing.T) {
	p, c, _ := autostartFileIn("darwin", "/Users/ann", "/x/host")
	if p != filepath.Join("/Users/ann", "Library", "LaunchAgents", "io.n2ns.n2n-nexus-host.tray.plist") || !strings.Contains(c, "<string>/x/host</string>") {
		t.Fatal(p, c)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	p, c, _ = autostartFileIn("linux", "/home/ann", "/x/host")
	if p != filepath.Join("/home/ann", ".config", "autostart", "n2n-nexus-host.desktop") || !strings.Contains(c, `Exec="/x/host"`) {
		t.Fatal(p, c)
	}
	if p, _, _ := autostartFileIn("windows", "C:/Users/ann", "x"); p != "" {
		t.Fatal(p)
	}
	if strings.Join(ServeArgs("/d", "/l"), " ") != "serve --supervise --root /d --log-dir /l" {
		t.Fatal(ServeArgs("/d", "/l"))
	}
}

// The service is told the installer's log directory, not left to derive it from its own environment.
func TestServicesGetTheLogDir(t *testing.T) {
	mustContain(t, WindowsRegisterScript(`C:\x\host.exe`, `C:\Users\ann\AppData\Local\n2n-nexus`, `C:\Users\ann\AppData\Local\n2n-nexus\logs`),
		`--log-dir "C:\Users\ann\AppData\Local\n2n-nexus\logs"`)
	mustContain(t, LaunchDaemonPlist("/x", "/d", "/Users/ann/Library/Logs/n2n-nexus", "ann", "/Users/ann"), "<string>--log-dir</string>\n\t\t<string>/Users/ann/Library/Logs/n2n-nexus</string>")
	mustContain(t, SystemdUnitFile("/x", "/d", "/home/ann/.local/state/n2n-nexus", "ann"), `"--log-dir" "/home/ann/.local/state/n2n-nexus"`)
	if CheckWindowsPath("--log-dir", `C:\%LOCALAPPDATA%\logs`) == nil {
		t.Error("CheckWindowsPath --log-dir")
	}
}
