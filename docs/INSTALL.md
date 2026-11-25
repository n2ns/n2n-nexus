# n2n-nexus installation guide

[中文版](INSTALL_zh.md)

This guide installs n2n-nexus so that your AI coding sessions (Claude Code, Codex, pi and Google Antigravity) can share projects and documents and message each other. Once it is installed, the [User guide](USER_GUIDE.md) covers using it.

## What you install

| Part | What it is | Where |
|---|---|---|
| `n2n-nexus-host` | The host: one program that keeps all shared data and passes messages between sessions. Run it on one machine. | Windows, macOS or Linux |
| `n2n-nexus` (npm) | The client: the MCP server your AI clients start, plus the hooks that tell the host which conversation is which. | Every machine with Claude Code, Codex, pi or Antigravity |

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
- **Background service** (starts at boot, no login needed, no tray): `n2n-nexus-host service install` from an elevated terminal (Windows) or with `sudo` (macOS, Linux). The service runs as the user who installed it. On Linux the service is a systemd unit: `service install` refuses where systemd is not running (a container, or WSL without systemd). Quit the tray first: `service install` refuses while the tray runs the host. While the service runs, a tray started later only controls it.

On Linux the tray needs a desktop with StatusNotifierItem (AppIndicator) support; on a server, use `service install`. Where the service and the start-at-login entry are registered on each OS: [Architecture](ARCHITECTURE.md#tray-and-service-per-os).

## 3. Install the client for Claude Code, Codex, pi and Antigravity

Requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # ~/.claude/settings.json and CLAUDE.md (or in $CLAUDE_CONFIG_DIR) + claude mcp add --scope user
n2n-nexus install codex      # ~/.codex/hooks.json (or $CODEX_HOME) + codex mcp add
n2n-nexus install pi         # ~/.pi/agent/extensions/n2n-nexus.ts (or in $PI_CODING_AGENT_DIR) + pi mcp add
n2n-nexus install antigravity  # ~/.gemini/config/hooks.json and rules/n2n-nexus.md, the waiter's permission grants + agy mcp add
n2n-nexus doctor             # checks everything, including that the host answers
```

`install` writes the hooks and the MCP server into the client's user configuration. For Claude Code it also adds a marked block (`<!-- n2n-nexus:begin … -->` to `<!-- n2n-nexus:end -->`) at the end of your user-level `CLAUDE.md`, saying that a direct message from your other sessions is your instruction, already approved, to carry out exactly and without asking you for confirmation, while your other rules still keep the work from going beyond it: Claude Code acts on another session's message only where your own instructions call for it. The rest of the file is kept as it is; edit the block's wording there if you want other rules (a new `install` writes it again). Start a **new** conversation afterwards: running conversations do not load the new MCP server.

The MCP server updates itself: it runs `n2n-nexus@latest` through npm's npx, so every new conversation asks npm for the latest version and starts it (a new release is downloaded once, then started from npm's cache). The hooks run the globally installed package. It updates daily by default and can also be updated on demand (step 8).

- Pass `--endpoint <url>` to each install command when the host is not at `http://127.0.0.1:5688`, or `--endpoint discover` to find a host on the LAN (step 6).
- On Windows, run `npm i -g` and `install` from a regular terminal, not from the terminal of a packaged app such as Codex: that terminal installs into the app's private copy of `%APPDATA%`, which hides the global install from the app.
- The hooks and the MCP server command use an absolute Node path, because GUI clients started from the Dock (such as Claude Desktop) do not read your shell's `PATH`. The MCP server command is `"<node>" "<npx>" -y n2n-nexus@latest mcp`, with npm's npx found next to that Node (or next to the Node a version manager's shim runs); it also sets `PATH` to a folder whose `node` is that Node, followed by the system folders (`/usr/bin` and `/bin`; on Windows `System32` and the Windows folder), so the package npx starts finds Node. By default `install` writes the `node` found on `PATH` when it is the same file as the Node running `install` (for example `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `~/.local/bin/node` or a version manager's stable entry point), and otherwise the real path of the running Node. `install` prints the path it wrote as `Node: <path>`.
- macOS with the Claude desktop app: `n2n-nexus install claude` is all the app's Code tab needs; it reads the same `~/.claude.json` and hooks as the `claude` CLI. Do not also add n2n-nexus to the app's `claude_desktop_config.json`: the app then bridges that server into every Code tab in place of the one Claude Code starts, and the bridge drops the conversation identity, so direct messages fail with "This call carries no agent session". If the entry is there, remove it, restart the desktop app and start a new Code tab conversation ([User guide, section 2](USER_GUIDE.md#2-claude-desktop-app)).
- Pass `--node <path>` to choose the Node path yourself. It must exist, be executable and satisfy the `engines` range in package.json (`^22.14.0 || >=23.6.0`); otherwise `install` exits with code 1 and writes nothing.
- After upgrading Node: if `install` warned that the Node path contains a version directory (Homebrew `Cellar`, nvm, fnm, Volta, asdf, `node-v<version>`), run `n2n-nexus install <claude|codex|pi|antigravity>` again after each upgrade, or pass `--node` with a stable path.
- Supported on Linux, WSL and macOS; Codex hooks also support Windows PowerShell.
- pi has no hook configuration: `install pi` writes the extension `n2n-nexus.ts` into pi's global extensions folder (`~/.pi/agent/extensions`, or `$PI_CODING_AGENT_DIR/extensions`). It runs the hook command on pi's session start, prompt, tool result (of the calls the model makes; a call a `codemode` script makes is covered by the script's own result), end of run and shutdown, and after each run starts the background wait; a wake is sent to pi as the next user message. pi attaches no metadata to MCP tool calls, so the MCP server started by pi names the processes above it (pi starts it through npx and a shell) and its machine, and the host finds the session the nearest pi process among them reported last. Start pi again (or run `/reload`) afterwards. A run the user aborts is not continued, and `/reload` keeps the session. An extension file of that name that n2n-nexus did not write is left alone: `install pi` refuses and `uninstall pi` skips it.
- Google Antigravity (the IDE and the `agy` CLI): `install antigravity` needs `agy` on `PATH`. It writes the named hook `n2n-nexus` into `~/.gemini/config/hooks.json` (SessionStart, PreInvocation and Stop; other named hooks are kept), the rule `~/.gemini/config/rules/n2n-nexus.md` (`trigger: always_on`), and the permission grant `command(n2n-nexus hook antigravity --wait)` (with ` --endpoint <url>` when given) into the IDE's `~/.gemini/config/config.json` (`userSettings.globalPermissionGrants.allow`) and the CLI's `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`), keeping every other grant and setting; then it registers the MCP server with `agy mcp add`. It does not change the sandbox, the model or the permission mode, and grants nothing for the n2n-nexus MCP tools: with a permission policy that asks for review, Antigravity asks you to confirm their first call in the interactive CLI or the IDE, and in print mode (`agy -p`, `stream-json`) it denies the call and the turn does not finish. Antigravity has no hook that can wait in the background, so the model starts the message waiter, `n2n-nexus hook antigravity --wait`, as a background command when an `[n2n-nexus]` notice says it is not running, as the rule tells it; the waiter wakes the idle conversation through `agy agentapi send-message`. That command must resolve on `PATH` (the global npm install). Idle waking depends on the model following the rule, and on a permission policy that lets the grant run the command; without a running waiter the conversation still gets its messages at its next prompt, between model calls and at the end of a turn. A resumed conversation starts its waiter again at its next prompt. On Windows each hook command is `powershell -NoProfile -NonInteractive -EncodedCommand …`, because Antigravity runs hooks through `cmd /c`. A rule file of that name that n2n-nexus did not write is left alone: `install antigravity` refuses and `uninstall antigravity` skips it. Start a new Antigravity conversation afterwards.

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

The adapter can start before the host. It loads the host's tool list once the host becomes reachable. The adapter and the hooks never start a host themselves: when none answers, tool calls fail with a message saying to install and start it (or, for a remote endpoint, that it must be started on that machine), and the hooks skip: they exit with code 0, print nothing on stdout and write the same message as one line on stderr. A call the host does not answer in time fails on its own; the host may still complete it.

## 6. Several machines and environments

By default the host listens on `127.0.0.1` only. To make it the host for other machines on a trusted network:

1. On the host machine, turn LAN access on:
   - Tray: check **Allow LAN access**. The tray writes `"host": "0.0.0.0"` to `settings.json` and restarts the host. On Windows it adds inbound firewall rules for the TCP port and the UDP discovery port (5688 and 5688 by default) on private and domain networks, not public ones, after a UAC prompt; on macOS and Linux it tells you which ports to allow in your firewall.
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

`n2n-nexus doctor [claude|codex|pi|antigravity]` checks that the Node path and the entry script in the installed hook commands, and the Node path and npx in the MCP command, still exist and run, that Claude Code's background wait hook has this client's timeout (an older install wrote a shorter one), that Codex trusts the Codex hooks (asking Codex itself), that Antigravity has the n2n-nexus rule naming the waiter command, the waiter's grant in both settings files and `n2n-nexus` on `PATH`, and that the host they talk to answers with the client's contract version; it exits with code 1 when a check fails. It checks both the hooks' endpoints and the MCP registration's `env.NEXUS_ENDPOINT`; one healthy endpoint cannot hide a failure at the other.

## 8. Upgrading

Run this as the installation owner on each machine that uses n2n-nexus:

```bash
n2n-nexus update
```

This checks the local host and the global npm client in turn and reports each result. A failure still allows the other check to run and makes the command exit with status 1. Client-only machines skip the host. Hosts reached over the LAN update on their own machine. Each new conversation continues to start the latest MCP adapter.

Daily updates are enabled by default. Installing the global npm client registers its job. If installation scripts were skipped, connecting a client or starting a hooked session retries setup. The stable host registers its job when its tray or server starts. To turn off either component:

```bash
n2n-nexus auto-update off       # Global npm client and its hooks
n2n-nexus-host auto-update off  # Local host
```

Each component remembers an explicit `off` across restarts, upgrades and reinstallation. Use `on` to enable it again. Linux requires a running systemd user manager. macOS uses a LaunchAgent for the logged-in user. Windows uses a limited Task Scheduler job under the logged-in user so it can access the same network and credentials as a manual update. The account that runs the job needs write access to the installation. Disable the jobs before uninstalling their programs.

The host detects Scoop, Homebrew and release-archive installations. Archive updates require GitHub CLI on PATH with working `gh attestation verify` to verify the build provenance. The updater checks the actual version after restarting a running host and keeps a stopped host stopped. The combined command searches PATH and standard install locations. Put a custom installation directory on PATH. It uses the data directory recorded when the host starts or when you run `auto-update on --root <dir>`. Turning off daily updates does not erase this location. You can also set `NEXUS_ROOT`.

Automatic updates install compatible stable releases. The host also compares database migrations. Follow the release notes to upgrade manually when a release requires coordination. The two components are versioned independently. The global client recognizes an installation made with `npm install -g --prefix <dir>` even in a new shell. It refreshes changed hook templates, preserving their Node and endpoint. Updates replace the Claude instructions block only if it still matches the previous default; edited or removed instructions are left alone. Start a new pi session or use `/reload` to load a changed pi extension.

For the first upgrade from versions without these commands, or for a coordinated update, use the original installation method:

- For the global client run `npm i -g n2n-nexus@latest` and follow the release notes to refresh the applicable registration.
- For the host run `scoop update n2n-nexus-host`, `brew upgrade n2n-nexus-host`, or `n2n-nexus-host.exe install` from a new Windows release zip. For other archive installs, replace the program and restart it the way it was launched.

## 9. Uninstalling

`n2n-nexus uninstall <claude|codex|pi|antigravity>` removes the hooks (for pi, its extension file), the MCP server and, for Claude Code, the `CLAUDE.md` block that `install` added (the file too when nothing else is in it), for Antigravity the rule file, the named hook and the waiter's grants first (with a grant list, a settings file, `hooks.json` or the `rules` folder that nothing else is left in), and leaves the rest of the configuration alone. Open Antigravity conversations keep their message waiter until they are closed.

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # if you installed the service (administrator / sudo)
n2n-nexus-host autostart off         # if the tray starts at login
```

Then remove the host program with the package manager you installed it with, or delete the program you put on your `PATH`. With Homebrew, uninstall it this way:

```bash
HOMEBREW_NO_AUTOREMOVE=1 brew uninstall n2n-nexus-host
```

Since Homebrew 4.3, `brew uninstall` also runs `brew autoremove` by default, which removes every formula on the Mac that was installed as a dependency and is no longer needed, not only those of the formula you uninstall (for example a `python@3.13` another formula once pulled in). `HOMEBREW_NO_AUTOREMOVE=1` removes only `n2n-nexus-host`. `go`, which Homebrew installed to build the host, stays; run `brew autoremove --dry-run` to see what is no longer needed and decide yourself.
