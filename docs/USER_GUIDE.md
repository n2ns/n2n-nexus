# n2n-nexus user guide

[中文版](USER_GUIDE_zh.md)

This guide covers using n2n-nexus once it is installed: the tray, which conversations can message each other, checking that it works, troubleshooting, and the reference of commands and settings. To install it, see the [Installation guide](INSTALL.md); for how the pieces work inside, see [Architecture](ARCHITECTURE.md); for the tools, see the [Tools reference](TOOLS_REFERENCE.md).

## 1. The tray

The tray menu shows the address the host listens on and the number of online sessions, opens the log and data folders, switches LAN access on and off, restarts the host and turns **Start at login** on or off (`n2n-nexus-host autostart on|off` does the same). The menu is in Chinese on a Chinese system and in English otherwise.

- **Allow LAN access** makes this host reachable from other machines: [Installation guide](INSTALL.md#6-several-machines-and-environments).
- **Restart** applies an edited `settings.json`. While the background service runs the host, the tray only controls it: **Restart** restarts the service's host.

## 2. Claude desktop app

The Claude desktop app has two kinds of conversation:

- **Code** tab: this is Claude Code. It uses the same `~/.claude/settings.json` hooks and MCP servers as the `claude` CLI, so after `n2n-nexus install claude` it can do everything, direct messages included.
- **Chat**: ordinary chat conversations. They can use MCP servers added to the desktop app's `claude_desktop_config.json`, but they run no hooks. There n2n-nexus offers the shared tools (projects, documents, meetings, tasks, global chat) but not direct messages, because nothing tells the host which chat is which.

Use the Code tab for sessions that should talk to each other.

**Do not add n2n-nexus to `claude_desktop_config.json`.** When the desktop app has it there, it also hands that server to every Code tab as a bridged ("sdk") server, which takes the place of the one Claude Code starts from `~/.claude.json`. The app's bridge forwards a tool call with only its name and arguments: the `claudecode/toolUseId` that the PreToolUse hook registered with the host is dropped, and the bridge connects to the adapter under the app's own client identity. Every direct-message tool in such a Code tab then fails with "This call carries no agent session", while message notices (hooks) still arrive. Seen on macOS with Claude desktop (Claude Code 2.1.308); the mechanism is in the desktop app, not in n2n-nexus. Fix: remove the `n2n-nexus` entry from `claude_desktop_config.json`, restart the desktop app and start a new Code tab conversation. The chat conversations then have no n2n-nexus tools, which costs nothing for direct messages (they never had them).

## 3. Direct messages between conversations

Each conversation appears in `peers`. A new direct message is announced to the recipient automatically: when the user sends a prompt, after each tool call, and once before the turn ends. The notification shows the message's text (`read` returns a message it cut), and what the recipient may do for it is set by your own instructions: for Claude Code, the block that `n2n-nexus install claude` writes into your user-level `CLAUDE.md` says to carry it out as your instruction without asking you for confirmation and without going beyond it; a question about it goes back to the sending session, so you do not have to switch terminals. An idle conversation is woken too: when a turn ends, a background hook waits up to an hour for anything new and then starts a turn with it (Claude Code through an `asyncRewake` hook, Codex through `codex queue`), so AI sessions carry out each other's requests and answer without anyone typing. An unattended `claude -p` run is not kept waiting: the hook returns at once there. A Codex conversation is woken only while it is loaded in the running Codex app, and not again after Codex restarts until it ends a turn; see [Architecture](ARCHITECTURE.md#sessions-presence-and-waking-idle-conversations) for the limits. With `listen` on, a conversation that finished its turn keeps waiting for up to about 10 minutes and continues when a message arrives; while it waits, input you type is queued until you press Esc.

## 4. Check that it works

- `n2n-nexus doctor` checks the installed commands and the host: [Installation guide](INSTALL.md#7-check-the-installation).
- In a conversation, ask the AI to call `peers`: it lists the other sessions that are online.
- The tray menu shows how many sessions are online.

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Tool calls say n2n-nexus-host is not available | The host is not running or not reachable: start it ([Installation guide, step 2](INSTALL.md#2-start-the-host)), or for another machine turn LAN access on ([step 6](INSTALL.md#6-several-machines-and-environments)). |
| Codex sessions never appear in `peers` | The Codex hooks are not trusted (yet, or again after a Codex update): `n2n-nexus doctor codex` says so; run `n2n-nexus install codex` again ([Installation guide, step 4](INSTALL.md#4-turn-on-the-codex-hooks-one-time-required)). |
| A conversation gets message notices but has no `read` / `reply` tools | The hooks are installed but the MCP server is not registered for this configuration. Common with several Claude config directories (`CLAUDE_CONFIG_DIR`, account switchers): run `CLAUDE_CONFIG_DIR=<that dir> n2n-nexus install claude`, then start a new conversation. |
| "This call carries no agent session" | The conversation started before the hooks were installed (start a new one), the MCP server is not named `n2n-nexus`, or an identity expired (call the tool again). In a Claude desktop chat this is expected, and in a Code tab it means the desktop app bridges n2n-nexus from `claude_desktop_config.json`: remove it there (section 2). |
| `claude -p` scripts | They are not held open by the background wait; nothing to do. |

## 6. Reference

### n2n-nexus-host commands

```bash
# Tray app (default)
n2n-nexus-host

# Run in the foreground without a tray; flags override settings.json (--port 0 picks a free port)
n2n-nexus-host serve [--host 127.0.0.1] [--port 5688] [--root <dir>]

# Background service that starts at boot (elevated terminal on Windows, sudo on macOS / Linux).
# install refuses while the tray runs the host (quit it first; reopened, it controls the service),
# writes --host / --port to settings.json, stops a host running for the data directory,
# registers and starts the service, and reports what answers on the port.
# uninstall removes the service and stops its host; a tray or a foreground serve keeps running.
n2n-nexus-host service install [--host <addr>] [--port <port>] [--root <dir>]
n2n-nexus-host service uninstall [--root <dir>]
n2n-nexus-host service status [--host <addr>] [--port <port>] [--root <dir>]

# Start the tray at login, or stop doing so
n2n-nexus-host autostart on|off

# Windows: install or upgrade from the folder of an extracted release (default %LOCALAPPDATA%\Programs\n2n-nexus-host)
n2n-nexus-host install [--dir <dir>]

n2n-nexus-host version
```

Under `sudo`, the service uses the default data and log directories of the user who ran `sudo`, unless `--root` names another data directory. Only one host runs per data directory: a second one exits with "another n2n-nexus-host is running".

### n2n-nexus commands

```bash
# Start the MCP adapter (launched by the IDE)
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp [--id <instance id>]

# Install / remove the hooks and MCP server for Claude Code or Codex (and the CLAUDE.md block for Claude Code)
n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
n2n-nexus uninstall <claude|codex>

# Check that the installed hook and MCP commands still run and that the host answers
# with the client's contract version (exit 1 when not)
n2n-nexus doctor [claude|codex]

# Hook entry point (written into the client configuration by install)
n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]
```

### Environment variables

Client (`n2n-nexus`):

| Variable | Description | Default |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | Host URL for the MCP adapter, the hooks and `doctor`, or `discover` to find one on the LAN | `http://127.0.0.1:5688` |
| `NEXUS_DISCOVERY_PORT` | UDP port the client queries with `discover` | `5688` |
| `NEXUS_INSTANCE_ID` | Override the MCP instance ID (identifies chat and meeting calls from clients without hooks) | `mcp-<hostname>-<hash of working directory>-<IDE name>` |
| `NEXUS_CODEX_COMMAND` | Codex command that the background wait runs as `<command> queue ...`, and that `install codex` and `doctor` ask about hook trust | `codex` (for trust on Windows: the Codex app's own copy) |

Host (`n2n-nexus-host`): only `NEXUS_ROOT`, the data directory (`--root` overrides it). Every other host setting is in `settings.json`, which the tray, the service and the command line share.

### settings.json

Read when the host starts; command-line flags override it. A missing file or field uses the default.

| Field | Description | Default |
| --- | --- | --- |
| `host` | Address to listen on (an IPv4 address listens on IPv4 only, an IPv6 address on IPv6 only); `0.0.0.0` makes the host reachable from the LAN | `"127.0.0.1"` |
| `port` | TCP port | `5688` |
| `discoveryPort` | UDP port of LAN discovery, answered only when `host` is not a loopback address | `5688` |
| `allowedHosts` | Extra DNS names accepted in the `Host` header (IP literals, `localhost` and `host.docker.internal` are always accepted) | `[]` |
| `rateLimit` | Tool calls per second per conversation (per instance without the hooks); each client address gets 5x. Hooks have their own budget at the same rate per conversation and 5x per client address. `0` disables rate limiting | `20` |
| `rateBurst` | Calls a conversation (an instance without the hooks) may make at once before the per-second limit applies (minimum 1) | `60` |
| `maxAutoTurns` | Automatic turns a conversation may take between its user's prompts (wakes, listening and Stops held open for messages); past it, direct messages wait until the user prompts. Meeting news is not counted or limited. `0` disables the limit | `0` |
| `stanceReminderMinutes` | Minutes a meeting may stay quiet while required approvers have not taken a stance on its current draft; then each of them is reminded once and the draft's author is told who is missing. Reminders never end a meeting. `0` turns them off | `10` |
| `meetingRetentionDays` | Days a meeting is kept after it was closed or archived (then it goes with its messages and decisions; `host_maintenance` `export` saves it as markdown first), and days without a message after which an active meeting is closed with `endReason: expired`. At least `1` | `30` |
| `retentionDays` | Days kept: read or expired direct messages, delivered notices, events, finished tasks, sessions without activity (unless a direct message still references them) and adapter instances not seen. At least `1` | `7` |

After editing the file, restart the host (tray **Restart**, or restart `serve` or the service).

### Data and logs

The host keeps all coordination data in one SQLite database in its data directory:

| Platform | Data directory | Log directory |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\n2n-nexus` | `%LOCALAPPDATA%\n2n-nexus\logs` |
| macOS | `~/Library/Application Support/n2n-nexus` | `~/Library/Logs/n2n-nexus` |
| Linux | `$XDG_DATA_HOME/n2n-nexus` (default `~/.local/share/n2n-nexus`) | `$XDG_STATE_HOME/n2n-nexus` (default `~/.local/state/n2n-nexus`) |

Override the data directory with `--root <path>` or `NEXUS_ROOT`.

```text
<data directory>/
├── nexus.db          # projects, assets, docs, meetings, global chat, events, tasks, read cursors, conversations, direct messages
├── settings.json     # host settings (see above)
└── host.lock         # one host per data directory
```

The background service, and the tray while it runs the host itself, log to `host.log` in the log directory (10 MB per file, 3 old files kept); the tray's own lines go to `tray.log` there; `n2n-nexus-host serve` logs to standard error. What the host deletes and when: [Architecture](ARCHITECTURE.md#maintenance-and-retention).

Data of n2n-nexus 0.x (`~/.n2n-nexus`) is not imported: the host does not read it and leaves it in place.
