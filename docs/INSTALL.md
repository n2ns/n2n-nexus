# n2n-nexus installation guide

[中文版](INSTALL_zh.md)

This guide installs n2n-nexus so that your AI coding sessions (Claude Code and Codex) can share projects and documents and message each other. Once it is installed, the [User guide](USER_GUIDE.md) covers using it.

## What you install

| Part | What it is | Where |
|---|---|---|
| `n2n-nexus-host` | The host: one program that keeps all shared data and passes messages between sessions. Run it on one machine. | Windows, macOS or Linux |
| `n2n-nexus` (npm) | The client: the MCP server your AI clients start, plus the hooks that tell the host which conversation is which. | Every machine with Claude Code or Codex |

## 1. Install the host

| Platform | Install |
|---|---|
| Windows (Scoop) | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`, then `scoop install n2ns/n2n-nexus-host` |
| Windows (release zip) | download `n2n-nexus-host_<version>_windows_<amd64\|arm64>.zip` from [Releases](https://github.com/n2ns/n2n-nexus/releases), extract it and run `n2n-nexus-host.exe install` in that folder |
| Windows (winget) | coming soon |
| macOS (Homebrew) | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | download `n2n-nexus-host_<version>_linux_<amd64\|arm64>.tar.gz` from [Releases](https://github.com/n2ns/n2n-nexus/releases), extract it and put `n2n-nexus-host` on your `PATH` |

[Releases](https://github.com/n2ns/n2n-nexus/releases) (tags `host-v<version>`) has the archives for every platform: `n2n-nexus-host_<version>_<os>_<arch>.zip` for Windows and `.tar.gz` for macOS and Linux, amd64 and arm64. Verify a download against the release's `SHA256SUMS` and its build provenance:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<version>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

Good to know:

- The binaries are not code-signed yet. On Windows, the first start of `n2n-nexus-host.exe` or `n2n-nexus-host-tray.exe` may show a SmartScreen warning: click **More info → Run anyway**. Homebrew builds the host from source on your Mac, so there is no Gatekeeper prompt.
- `n2n-nexus-host.exe install` (Windows) copies both programs to `%LOCALAPPDATA%\Programs\n2n-nexus-host` (`--dir` for another folder), turns **Start at login** on the first time, starts the tray and says what it did. It is also how you upgrade: run it again from a newer release; it replaces the programs (the running ones are moved aside as `.old` and removed by the next install), ends the previous tray and starts the new one, and, when the background service runs the installed program, restarts the service on the new one for the same data directory after an administrator prompt. Scoop and Homebrew installs upgrade with their package manager instead.
- On Windows the package has two programs: `n2n-nexus-host.exe` for commands, and `n2n-nexus-host-tray.exe`, the tray, which opens no console window. `n2n-nexus-host` without arguments starts the tray program and returns.

## 2. Start the host

Start it in one of two ways:

- **Tray app**: run `n2n-nexus-host` without arguments. The first time the tray runs it turns **Start at login** on; after that it stays as you set it. What the tray menu does: [User guide](USER_GUIDE.md#1-the-tray).
- **Background service** (starts at boot, no login needed, no tray): `n2n-nexus-host service install` from an elevated terminal (Windows) or with `sudo` (macOS, Linux). The service runs as the user who installed it. Quit the tray first: `service install` refuses while the tray runs the host. While the service runs, a tray started later only controls it.

On Linux the tray needs a desktop with StatusNotifierItem (AppIndicator) support; on a server, use `service install`. Where the service and the start-at-login entry are registered on each OS: [Architecture](ARCHITECTURE.md#tray-and-service-per-os).

## 3. Install the client for Claude Code and Codex

Requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # ~/.claude/settings.json and CLAUDE.md (or in $CLAUDE_CONFIG_DIR) + claude mcp add --scope user
n2n-nexus install codex      # ~/.codex/hooks.json (or $CODEX_HOME) + codex mcp add
n2n-nexus doctor             # checks everything, including that the host answers
```

`install` writes the hooks and the MCP server into the client's user configuration. For Claude Code it also adds a marked block (`<!-- n2n-nexus:begin … -->` to `<!-- n2n-nexus:end -->`) at the end of your user-level `CLAUDE.md`, saying that a direct message from your other sessions is your instruction, already approved, to carry out exactly and without asking you for confirmation, while your other rules still keep the work from going beyond it: Claude Code acts on another session's message only where your own instructions call for it. The rest of the file is kept as it is; edit the block's wording there if you want other rules (a new `install` writes it again). Start a **new** conversation afterwards: running conversations do not load the new MCP server.

The MCP server updates itself: it runs `n2n-nexus@latest` through npm's npx, so every new conversation asks npm for the latest version and starts it (a new release is downloaded once, then started from npm's cache). The hooks run the globally installed package, which you update yourself (step 8).

- Pass `--endpoint <url>` to both commands when the host is not at `http://127.0.0.1:5688`, or `--endpoint discover` to find a host on the LAN (step 6).
- On Windows, run `npm i -g` and `install` from a regular terminal, not from the terminal of a packaged app such as Codex: that terminal installs into the app's private copy of `%APPDATA%`, which hides the global install from the app.
- The hooks and the MCP server command use an absolute Node path, because GUI clients started from the Dock (such as Claude Desktop) do not read your shell's `PATH`. The MCP server command is `"<node>" "<npx>" -y n2n-nexus@latest mcp`, with npm's npx found next to that Node (or next to the Node a version manager's shim runs); it also sets `PATH` to a folder whose `node` is that Node, followed by the system folders (`/usr/bin` and `/bin`; on Windows `System32` and the Windows folder), so the package npx starts finds Node. By default `install` writes the `node` found on `PATH` when it is the same file as the Node running `install` (for example `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `~/.local/bin/node` or a version manager's stable entry point), and otherwise the real path of the running Node. `install` prints the path it wrote as `Node: <path>`.
- macOS with the Claude desktop app: `n2n-nexus install claude` is all the app's Code tab needs; it reads the same `~/.claude.json` and hooks as the `claude` CLI. Do not also add n2n-nexus to the app's `claude_desktop_config.json`: the app then bridges that server into every Code tab in place of the one Claude Code starts, and the bridge drops the conversation identity, so direct messages fail with "This call carries no agent session". If the entry is there, remove it, restart the desktop app and start a new Code tab conversation ([User guide, section 2](USER_GUIDE.md#2-claude-desktop-app)).
- Pass `--node <path>` to choose the Node path yourself. It must exist, be executable and satisfy the `engines` range in package.json (`^22.14.0 || >=23.6.0`); otherwise `install` exits with code 1 and writes nothing.
- After upgrading Node: if `install` warned that the Node path contains a version directory (Homebrew `Cellar`, nvm, fnm, Volta, asdf, `node-v<version>`), run `n2n-nexus install <claude|codex>` again after each upgrade, or pass `--node` with a stable path.
- Supported on Linux, WSL and macOS; Codex hooks also support Windows PowerShell.

## 4. Turn on the Codex hooks (one-time, required)

Codex does not run hooks that someone else wrote until they are trusted. Without trust, Codex conversations still get the shared tools, but they cannot send or receive direct messages, and the host never sees them come online.

`n2n-nexus install codex` trusts the n2n-nexus hooks for you: it asks Codex itself for each hook's trust hash (`codex app-server`) and stores it, as Codex's own settings do. On Windows it uses the copy of Codex that the Codex app runs (`%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`), elsewhere `codex` on `PATH` (`NEXUS_CODEX_COMMAND` overrides both). It prints `Trusted the 6 n2n-nexus hooks in Codex (...)`; then start a new Codex conversation.

If it prints `Could not trust the hooks automatically`, trust them by hand:

- Codex app: open its settings, find the hooks, and trust the n2n-nexus entries.
- Codex CLI: run `codex`, type `/hooks`, and trust the n2n-nexus entries.

The entries are SessionStart, SessionEnd, UserPromptSubmit, PostToolUse and two Stop hooks; their commands run `n2n-nexus … hook codex`.

Good to know:

- Codex stores the trust per hook in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), as a hash Codex computes from the hook's whole configuration. The CLI and the Codex app share the file, but the hash depends on the Codex version: when the CLI on `PATH` is older or newer than the app's own copy, one of them may see the hooks as modified. The app's copy decides, which is why `install` prefers it.
- Trust has to be given again when a hook changes (another `--endpoint` or `--node`, a Node.js that moved) or when a Codex update computes the hash differently. `n2n-nexus doctor codex` checks the trust with Codex and reports `FAIL hook trust` then; run `n2n-nexus install codex` again. Upgrading the npm package alone does not change the hooks.
- Hooks are on by default in current Codex versions. If a policy or your own `config.toml` sets `[features] hooks = false`, they do not run at all.

Official documentation: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude Code needs no such step: it runs the hooks in `settings.json` as soon as `install claude` has written them.

## 5. Other MCP clients

Other MCP clients can use every tool except direct messages:

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": {
        "NEXUS_ENDPOINT": "http://127.0.0.1:5688"
      }
    }
  }
}
```

The adapter can start before the host. It loads the host's tool list once the host becomes reachable. The adapter and the hooks never start a host themselves: when none answers, tool calls fail with a message saying how to start it (or, for a remote endpoint, that it must be started on that machine), and the hooks skip silently. A call the host does not answer in time fails on its own; the host may still complete it.

## 6. Several machines and environments

By default the host listens on `127.0.0.1` only. To make it the host for other machines on a trusted network:

1. On the host machine, turn LAN access on:
   - Tray: check **Allow LAN access**. The tray writes `"host": "0.0.0.0"` to `settings.json` and restarts the host. On Windows it adds inbound firewall rules for the TCP port and the UDP discovery port (5688 and 5688 by default) after a UAC prompt; on macOS and Linux it tells you which ports to allow in your firewall.
   - Service: `n2n-nexus-host service install --host 0.0.0.0` writes the address to `settings.json`; allow TCP 5688 and UDP 5688 in the firewall yourself.
2. On the other machines, install the client with `--endpoint discover` (for example `n2n-nexus install claude --endpoint discover`), or with the host's address.

With `discover`, the adapter and the hooks broadcast a query on UDP `NEXUS_DISCOVERY_PORT` and use the first host that answers; the result is cached in `~/.n2n-nexus/discovered-endpoint` and looked up again when that host cannot be reached. A host answers only when it listens on a non-loopback address (LAN access on), so allow UDP and TCP 5688 through its firewall for the trusted network. When none answers, the client uses `http://127.0.0.1:5688` (a host on this machine) and looks again after a minute.

| Scenario | `--endpoint` / `NEXUS_ENDPOINT` |
| --- | --- |
| Same machine | `http://127.0.0.1:5688` |
| WSL IDE to Windows host | `http://host.docker.internal:5688` |
| Windows IDE to WSL host | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |
| Find a host on the LAN | `discover` |

On macOS the first connection may trigger a **Local Network** permission prompt for the app that runs the client (Claude, Terminal, VS Code). Allow it; otherwise the client cannot reach the host (**System Settings → Privacy & Security → Local Network**).

IPv6 discovery keeps the HTTP address family: a host bound to `::` on this machine resolves to `[::1]`, and a concrete IPv6 bind address is used as advertised. An IPv4 UDP reply from another machine cannot identify that machine's IPv6 wildcard address (`::`); configure a concrete reachable IPv6 bind address or an explicit `http://[IPv6]:port` endpoint for that case.

## 7. Check the installation

`n2n-nexus doctor [claude|codex]` checks that the Node path and the entry script in the installed hook commands, and the Node path and npx in the MCP command, still exist and run, that Codex trusts the Codex hooks (asking Codex itself), and that the host they talk to answers with the client's contract version; it exits with code 1 when a check fails. It checks both the hooks' endpoints and the MCP registration's `env.NEXUS_ENDPOINT`; one healthy endpoint cannot hide a failure at the other.

## 8. Upgrading

- Client: the MCP server needs nothing: each new conversation starts the latest version (a running conversation keeps the one it started with). For the hooks, run `npm i -g n2n-nexus@latest`; they use the new version at once.
- Host: upgrade with the package manager you installed it with (`scoop update n2n-nexus-host`, `brew upgrade n2n-nexus-host`). A Windows install from the release zip upgrades with `n2n-nexus-host.exe install` from the newer release, which restarts the tray and the background service itself. Otherwise replace the program, then restart it (tray: **Restart**; service: run `n2n-nexus-host service install` again from an administrator terminal).

## 9. Uninstalling

`n2n-nexus uninstall <claude|codex>` removes the hooks, the MCP server and, for Claude Code, the `CLAUDE.md` block that `install` added (the file too when nothing else is in it) and leaves the rest of the configuration alone.

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # if you installed the service (administrator / sudo)
n2n-nexus-host autostart off         # if the tray starts at login
```
