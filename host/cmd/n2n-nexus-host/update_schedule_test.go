//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/n2ns/n2n-nexus/autoupdate"
)

func TestUnixScheduleRoundTrip(t *testing.T) {
	for _, platform := range []string{"Linux", "Darwin"} {
		t.Run(platform, func(t *testing.T) {
			home := t.TempDir()
			bin := filepath.Join(home, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			write := func(name, body string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			write("uname", "echo "+platform)
			write("systemctl", `printf '%s\n' "$*" >> "$HOME/calls"`)
			write("launchctl", `printf '%s\n' "$*" >> "$HOME/calls"; test "$1" != print`)
			write("probe", `printf '%s\n' "$1" "$2" "$CODEX_HOME" > "$HOME/result"`)
			t.Setenv("HOME", home)
			t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			const literal = "a b'c $HOME & $(exit 9)"
			t.Setenv("CODEX_HOME", literal)
			run := func(args ...string) {
				t.Helper()
				cmd := exec.Command("/bin/sh", args...)
				if b, e := cmd.CombinedOutput(); e != nil {
					t.Fatalf("%v: %s", e, b)
				}
			}
			schedule := func(args ...string) { run(append([]string{"-c", autoupdate.Unix, "schedule"}, args...)...) }
			schedule("on", "host", filepath.Join(bin, "probe"), literal, "")
			schedule("on", "client", filepath.Join(bin, "probe"), "client", "second")
			runner := filepath.Join(home, ".local/share/n2n-nexus/updates/host.sh")
			run(runner)
			result, err := os.ReadFile(filepath.Join(home, "result"))
			if err != nil || string(result) != literal+"\n\n"+literal+"\n" {
				t.Fatalf("runner arguments or environment changed: %q, %v", result, err)
			}
			calls, err := os.ReadFile(filepath.Join(home, "calls"))
			if err != nil || !strings.Contains(string(calls), "io.n2ns.n2n-nexus.update.host") {
				t.Fatalf("scheduler calls: %q %v", calls, err)
			}
			schedule("off", "host")
			if _, err := os.Stat(runner); !os.IsNotExist(err) {
				t.Fatal("host runner still exists", err)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(runner), "client.sh")); err != nil {
				t.Fatal("off removed other component", err)
			}
		})
	}
}

func TestSavedUpdateRootBelongsToCurrentExecutable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	target, err := updateRootFile()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err = saveUpdateRoot(root, "on"); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != root {
		t.Fatalf("got %q, %v", saved, err)
	}
	if err = os.WriteFile(target, []byte(`{"Root":"/example","Executable":"/another/install/bin/n2n-nexus-host"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != "" {
		t.Fatalf("got %q, %v", saved, err)
	}
}

func TestHostDailyUpdatesDefaultAndChoice(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("PATH", home+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NEXUS_ROOT", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	originalVersion := version
	t.Cleanup(func() { version = originalVersion })
	version = "1.2.3"
	put := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0700); err != nil {
			t.Fatal(err)
		}
	}
	put("uname", "#!/bin/sh\necho Linux\n")
	put("systemctl", `#!/bin/sh
test "$XDG_RUNTIME_DIR" = "/run/user/$(id -u)" || exit 1
test ! -f "$HOME/bus-offline" || exit 1
case "$2" in
 enable) test -f "$HOME/available" || exit 1; touch "$HOME/enabled"; echo registered >> "$HOME/calls";;
 is-enabled) test -f "$HOME/enabled";;
 disable) rm -f "$HOME/enabled";;
esac
`)
	configure := func(action, root string) error { return configureHostSchedule(t.Context(), action, root, "") }
	root := filepath.Join(home, "data")
	if err := configure("default", root); err == nil {
		t.Fatal("expected registration failure")
	}
	put("available", "")
	if err := configure("default", root); err != nil {
		t.Fatal(err)
	}
	if err := configure("default", filepath.Join(home, "other")); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != filepath.Join(home, "other") {
		t.Fatalf("default schedule kept a stale data directory: %q, %v", saved, err)
	}
	put("bus-offline", "")
	if err := configure("off", ""); err == nil {
		t.Fatal("expected unavailable scheduler to prevent deregistration")
	}
	dir := filepath.Join(home, ".local/share/n2n-nexus/updates")
	if _, err := os.Stat(filepath.Join(dir, "host.sh")); !os.IsNotExist(err) {
		t.Fatal("failed disable left an executable runner", err)
	}
	if err := os.Remove(filepath.Join(home, "bus-offline")); err != nil {
		t.Fatal(err)
	}
	if err := configure("default", root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "enabled")); !os.IsNotExist(err) {
		t.Fatal("default overrode off", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "host-removal-pending")); !os.IsNotExist(err) {
		t.Fatal("pending deregistration was not cleared", err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != root {
		t.Fatalf("disabled scheduler lost the manual update root: %q, %v", saved, err)
	}
	moved := filepath.Join(home, "moved-while-disabled")
	if err := configure("default", moved); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != moved {
		t.Fatalf("manual update missed the new root: %q, %v", saved, err)
	}
	if err := configure("on", root); err != nil {
		t.Fatal(err)
	}
	if err := configure("default", filepath.Join(home, "other")); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != root {
		t.Fatalf("explicit root changed: %q, %v", saved, err)
	}
	if err := configure("off", ""); err != nil {
		t.Fatal(err)
	}
	if saved, err := savedUpdateRoot(); err != nil || saved != root {
		t.Fatalf("turning off the job changed the manual update root: %q, %v", saved, err)
	}
	calls, err := os.ReadFile(filepath.Join(home, "calls"))
	if err != nil || string(calls) != "registered\nregistered\n" {
		t.Fatalf("unexpected registrations: %q %v", calls, err)
	}
}
