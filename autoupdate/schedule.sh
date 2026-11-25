# Invoked by the host and npm CLIs as sh -c ... schedule on|off|status host|client [argv...].
set -eu
umask 077
action=$1
component=$2
shift 2
case "$action" in on|off|status) ;; *) exit 2 ;; esac
case "$component" in host|client) ;; *) exit 2 ;; esac
label="io.n2ns.n2n-nexus.update.$component"
dir="$HOME/.local/share/n2n-nexus/updates"
runner="$dir/$component.sh"
pending="$dir/$component-removal-pending"
if [ "$action" = off ]; then
    mkdir -p "$dir"
    : > "$pending"
    rm -f "$runner"
fi
os=$(uname -s)

# Write literal argv and selected non-secret configuration paths to the runner.
# POSIX single quotes preserve spaces, dollars, apostrophes and newlines.
quote() {
    printf "'"
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
    printf "'"
}
write_runner() {
    mkdir -p "$dir"
    tmp=$(mktemp "$dir/.runner.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    {
        echo '#!/bin/sh'
        for key in PATH npm_config_prefix NPM_CONFIG_PREFIX NPM_CONFIG_USERCONFIG npm_config_userconfig CLAUDE_CONFIG_DIR CODEX_HOME PI_CODING_AGENT_DIR XDG_CONFIG_HOME XDG_DATA_HOME; do
            eval "value=\${$key-}"
            if [ -n "$value" ]; then
                printf 'export %s=' "$key"
                quote "$value"
                printf '\n'
            fi
        done
        printf 'exec'
        for arg do printf ' '; quote "$arg"; done
        printf '\n'
    } > "$tmp"
    mv -f "$tmp" "$runner"
}
case "$os" in
    Linux)
        # The scheduler runs under the same account as the installation.
        # A system service started with User= has no login-session environment.
        if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
            XDG_RUNTIME_DIR="/run/user/$(id -u)"
            export XDG_RUNTIME_DIR
        fi
        systemctl --user show-environment >/dev/null || {
            echo 'A running systemd user manager is required for daily updates.' >&2
            exit 1
        }
        units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        if [ "$action" = status ]; then
            [ -f "$runner" ] && [ -f "$units/$label.timer" ] || exit 3
            if systemctl --user is-enabled --quiet "$label.timer" && systemctl --user is-active --quiet "$label.timer"; then exit 0; fi
            exit 3
        fi
        if [ "$action" = off ]; then
            if [ -f "$units/$label.timer" ]; then systemctl --user disable --now "$label.timer"; fi
            rm -f "$units/$label.timer" "$units/$label.service" "$runner"
            systemctl --user daemon-reload
        else
            write_runner "$@"
            mkdir -p "$units"
            cat > "$units/$label.service" <<UNIT
[Unit]
Description=Check n2n-nexus $component for compatible updates
[Service]
Type=oneshot
ExecStart=/bin/sh "%h/.local/share/n2n-nexus/updates/$component.sh"
UNIT
            cat > "$units/$label.timer" <<UNIT
[Unit]
Description=Daily n2n-nexus $component update
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m
[Install]
WantedBy=timers.target
UNIT
            systemctl --user daemon-reload
            systemctl --user enable --now "$label.timer"
        fi
        ;;
    Darwin)
        agents="$HOME/Library/LaunchAgents"
        plist="$agents/$label.plist"
        domain="gui/$(id -u)"
        if [ "$action" = status ]; then
            [ -f "$runner" ] && [ -f "$plist" ] || exit 3
            launchctl print "$domain" >/dev/null || exit 1
            if launchctl print "$domain/$label" >/dev/null 2>&1; then exit 0; fi
            exit 3
        fi
        if launchctl print "$domain/$label" >/dev/null 2>&1; then launchctl bootout "$domain/$label"; fi
        if [ "$action" = off ]; then
            rm -f "$plist" "$runner"
        else
            write_runner "$@"
            mkdir -p "$agents"
            xml_path=$(printf '%s' "$runner" | sed 's/\&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g')
            cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$xml_path</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>15</integer></dict>
<key>StandardOutPath</key><string>$xml_path.log</string>
<key>StandardErrorPath</key><string>$xml_path.log</string>
</dict></plist>
PLIST
            launchctl bootstrap "$domain" "$plist"
        fi
        ;;
    *) echo "Unsupported scheduler platform: $os" >&2; exit 1 ;;
esac
rm -f "$pending"
printf '%s updates: %s (%s)\n' "$component" "$action" "$label"
