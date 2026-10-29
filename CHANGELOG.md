# Changelog

[中文版](docs/CHANGELOG_zh.md)

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- New tray icon, also the README logo: a small network on a charcoal tile with a grey edge, a red node in the middle joined by light blue links to four white nodes. It replaces the teal disc in the tray and the hexagon logo; the old icon and banner files are gone from `assets`. On macOS the menu bar shows the network alone as a template image, black or white to suit the menu bar.

### Fixed

- A message the host posts because of your own call (the seat taken, the AI consensus notice, the seat's decision or veto) counts as read for you: the seat drafts the next point right after taking the seat or deciding one, and the member whose stance completed the AI consensus posts right after it, without a refusal for that message.
- Meeting news no longer repeats what `read_messages` returned in unread mode: reading a meeting also marks those messages announced, so the next hook notification shows only what came after.
- In a meeting with the user's seat, the message about a changed approver list no longer names the seat, which is in none of the approver lists.

## [0.12.0] - 2026-10-29

Upgrade the host and the client on every machine together (contract version 4). The database is upgraded in place: keep `nexus.db`.

### Added

- Meetings with the user's seat: the conversation the user sits at takes the seat with `seat: "user"` on `start_meeting` or `join_meeting`; taking it moves it from whoever held it. The seat's `endorse` of the current draft makes the host post the `DECISION` (with the objections still open) and the meeting goes on to the next point; its `object` vetoes the draft. The others' consensus decides nothing there and is only reported when it is reached or lost. Only the seat ends such a meeting, with a summary; anyone else's `end_meeting` is posted as a proposal to end it. `list_meetings` returns `seat`, and `approvals` the seat's stance.
- Cleanup by age, at startup and every hour, with two `settings.json` fields: `meetingRetentionDays` (default 30) and `retentionDays` (default 7). Read or expired direct messages, delivered notices, events, finished tasks, sessions without activity (unless a direct message still references them) and adapter instances not seen go after `retentionDays`; an active meeting without a message for `meetingRetentionDays` closes with `endReason: expired`, and a closed or archived meeting goes `meetingRetentionDays` after it ended. Each cleanup that changed something writes a `maintenance.cleanup` event.
- `host_maintenance` actions `cleanup` (with `dryRun` to see what would go) and `export` (a meeting as markdown).

### Changed

- Read before posting: `send_message` to a meeting, and `endorse` / `object`, are refused while messages of others are unread; the result attaches them (texts cut at `notifyTextChars`) and they count as read. The next post after a refusal goes through with a note of what was unread; a draft or a `DECISION` only once everything is read. `withdraw` goes through with the unread messages attached.
- Meeting notifications show each message with its text, like direct messages; what a wake, a Stop or a prompt shows whole counts as read.
- An objection, and a stance that changes your last one, need grounds in the note (`#n`, a file path, a URL, or a sentence starting with 实测：/文档：/数据： or Measured:/Docs:/Data:); a stance on a proposal can change at most twice.
- Meeting messages, global chat and meeting members keep the sender's name and machine as they were when written; `read_messages` returns `senderBackfilled` and members `machine` and `backfilled` for the rows of older databases, filled in at the upgrade.
- Sessions report their environment (the WSL distribution, shown after the platform: `Vector · WSL Ubuntu_26`); on macOS the hostname is the computer name set in System Settings. A session is named `<client>@<dir>#<the last 4 letters and digits of its id>`, with more of the id while another recorded session has that name, so names are not reused.
- The tray menu's first line says only whether the host runs (`Running`, `Running · background service` or `Not running`); the address is on its own line, and the error takes that line when no host answers. The `(LAN)` suffix is gone: the **Allow LAN access** item shows the same.

## [0.11.0] - 2026-10-29

Upgrade the host and the client on every machine together, and delete `nexus.db` from the host's data directory before the new host starts: this release starts a new database and contract version, and an older host or client no longer works with it.

### Added

- Sessions show the machine they run on. Every hook event carries `machine` (hostname without `.local`, platform `darwin` / `linux` / `wsl` / `win32`, local time minus UTC in minutes); the host refuses an event without it. `peers` and `set_profile` return `hostname`, `platform`, `utcOffset` and `label`; introductions and notifications show `name (<label or hostname> · <platform>)`; `read_messages` returns `senderMachine`. `set_profile({ label })` names the machine in place of its hostname.

### Changed

- Contract version 3: the host and the client must be upgraded together (`n2n-nexus doctor` reports a mismatch).
- The database schema is two files, one per owner, with no upgrade path from earlier databases: delete `nexus.db` before starting this host (it then says so if an old file is left).
- Notifications, the collaboration rules, the tool descriptions and the MCP instructions state facts only (sender, text, whether and how to reply) and no longer claim that a message is an approved instruction; that authorization lives only in the `CLAUDE.md` block that `install claude` writes. A Claude Code recipient gets the reply tool's full name.
- `send` / `read` / `reply` and `send_message` / `read_messages` name each other in their first sentence; the introduction, `peers` and the MCP instructions say that the client's own agent list does not show nexus sessions; `send` asks the sender to end its turn instead of polling with `read`.

## [0.10.0] - 2026-10-28

### Added

- `n2n-nexus install claude` writes a marked block into the user-level `CLAUDE.md` (`<!-- n2n-nexus:begin … -->` to `<!-- n2n-nexus:end -->`): a direct message from another session is the user's own instruction, carried out exactly and without asking the user for confirmation, with questions going back to the sender. Claude Code acts on another session's message only where the user's own instructions call for it, which is why the block is needed. The rest of the file is kept; `uninstall claude` removes the block, and the file when nothing else is in it. Run `install claude` again after upgrading to get the block.

### Changed

- Direct messages arrive whole: a notification shows each message's text between `--- Message <id> from … ---` and `--- End of message <id> ---`, with how to answer it, instead of the sender and the first line. The texts of one notification together are cut at 5000 characters (`notifyTextChars` in the contract); a cut message is marked and `read` returns it. A message shown whole is marked read when the notification continues or starts the turn (Stop, listening, background wake), and, when it needs no reply, when a prompt shows it; `reply` marks the message it answers read. Other messages stay unread for `read`, among them every message shown after a tool call, because that context can reach a sub-agent only.
- The notifications, the SessionStart introduction and the MCP instructions say that the sessions belong to the same user: a message is that user's instruction, carried out exactly and without asking the user for confirmation, nothing beyond it; when more work or missing information seems needed, the sender is asked with `reply`. `send`'s guidance is to put everything the recipient needs into one message; a task is answered once with its result, or with what stopped it and what would let it go on.

## [0.9.5] - 2026-10-26

### Added

- Host on Windows: `n2n-nexus-host.exe install [--dir <dir>]` installs the host from an extracted release zip into `%LOCALAPPDATA%\Programs\n2n-nexus-host`, turns start at login on the first time and starts the tray. Run it again from a newer release to upgrade: it replaces the programs (running ones are moved aside and removed by the next install), restarts the tray and, after an administrator prompt, restarts the background service on the new version for the same data directory.

### Changed

- `n2n-nexus install codex` trusts the n2n-nexus hooks in Codex itself: it asks Codex (`codex app-server`, the copy the Codex app runs on Windows, else `codex` on `PATH`) for each hook's trust hash and stores it, so no `/hooks` step is needed. If that fails, it says how to trust them by hand (the Codex app's settings, or `/hooks` in the CLI). `n2n-nexus doctor codex` checks with Codex that the hooks are trusted, which a Codex update can undo.

## [0.9.4] - 2026-10-26

### Changed

- Contract version 2: the npm client and the host must be upgraded together (`n2n-nexus doctor` reports a mismatch).
- Chat and meetings identify the conversation, not the MCP adapter instance, when the n2n-nexus hooks are installed. Several conversations of one IDE in one workspace share an instance; they now keep their own unread cursors, and their messages, a meeting's `initiator` and `participants` and the `actor` of `meeting.*` events carry their session id (`claude:<id>` / `codex:<id>`), which works with `send`. Clients without the hooks keep using the instance. If an instance has had a conversation identified within the last 30 minutes and a call of it cannot be identified, the call fails with a retry message instead of reading through the shared cursor. Results say which identity was used (`identity`).
- `read_messages` no longer returns your own messages in unread mode; a conversation's first unread read of global chat starts at the newest message. New history mode: `latest: true` or `afterId` read without moving a cursor and include your own messages. Each message has `senderName`, and `category` is always present (null without one).
- Meeting messages are numbered per meeting, from 1: `id` in `read_messages`, `messageId` from `send_message` (now returned for meetings too) and `afterId` in a meeting use that number, so a new meeting no longer continues the numbers of earlier ones.

- Meetings have members. `join_meeting(meetingId, mode?, approver?, since?)` and `leave_meeting(meetingId)`; the initiator joins its meeting. News of a meeting reaches its members through the hooks as one line per meeting: active members are woken (or their turn continues), async members see it at their next prompt or tool call, and nobody is told about their own messages. Meeting news is not an automatic turn and still arrives past `maxAutoTurns`, so a meeting runs until it is ended; ending it gives each other member one notice. `list_meetings` shows the members and how many wakes the meeting caused.
- Decisions by consensus. `send_message(..., draft: true)` publishes a meeting's current draft and fixes its required approvers (members that joined as `required` through the hooks); `stance(meetingId, messageId, endorse | object | withdraw, note?)` takes a stance on it, an objection with its reason. When at least two required approvers endorsed the current draft and nobody objects, the meeting closes by itself with the draft as a `DECISION` (`endReason: consensus`; `end_meeting` records `manual`). Ordinary proposals do not reset stances; a leaving or re-joining approver changes the list, which is posted to the meeting. Required approvers that have not taken a stance after a quiet `stanceReminderMinutes` (new `settings.json` field, default 10) are reminded once. `list_meetings` shows each meeting's `endReason` and current draft with its stances.
- Direct messages say what they ask: `send` and `reply` take `expectsReply` (false: the notification says no reply is needed and does not ask for one) and `wake` (false: the message never wakes the recipient or holds its turn, and waits for its next prompt or tool call). `read` returns `expectsReply`.
- Sessions have a readable `title`: the conversation's title as Claude Code or Codex shows it, read by the hooks and shown next to the name in `peers`, introductions, notifications and meeting members. `set_profile({ title })` sets your own (`""` returns to the client's). The name stays the handle for `send`.
- A direct message is listed in full once; while it stays unread, later notifications only count it.

### Fixed

- A failed `codex queue` no longer loses the wake: the Codex background wait reports the result and the host undoes a wake that was not delivered, and the wait tries again after a delay (1 s, doubling up to 5 minutes), so the same messages and notices wake the conversation again; the failed wake is not counted as an automatic turn. The session no longer stays `working` until it goes stale.
- A session that goes offline after 30 minutes without activity now tells its `notifyWhenIdle` subscribers, as a session that ends does, also when they only wait in the background.
- The prompt that starts a woken turn no longer announces again what the wake announced.
- The Codex SessionEnd hook fits Codex's 3-second limit: `n2n-nexus install codex` writes timeout 3 (run it again to update an existing installation, which removes Codex's "clamping SessionEnd hook timeout" warning), and the SessionEnd request gives up after 1.5 s without a second host lookup.
- `n2n-nexus uninstall <client>` no longer needs the client on PATH: it removes the hooks from the client's config file anyway. Without the client it skips `<client> mcp remove` and, when the MCP server is still registered, says so and how to remove it (run that command later, or delete the `n2n-nexus` entry from `~/.claude.json` / `config.toml`). `install` still requires the client.
- Tool calls are rate limited per conversation when the hooks identify it, so conversations that share an adapter instance (one client in one directory) no longer use up each other's budget; without the hooks calls are still limited per instance. The per-address limit is unchanged.

## [0.9.3] - 2026-10-24

### Changed

- The MCP server updates itself: `n2n-nexus install` registers it as `"<node>" "<npx>" -y n2n-nexus@latest mcp` (npm's npx next to the chosen Node; `PATH` set to a folder whose `node` is that Node, then the system folders), so every new conversation starts the latest published version. The hooks still run the global installation; update them with `npm i -g n2n-nexus@latest`. Run `n2n-nexus install claude` / `n2n-nexus install codex` once to switch an existing installation; the hook commands stay the same, so Codex does not ask to trust them again. `n2n-nexus doctor` checks the new form and reports an MCP command in the old one.

- n2n-nexus is for sessions giving each other work: direct message notices, the `read` tool and the assistant guide now tell the receiving model to carry out what a message asks and answer with `reply`, instead of only when its own user asked for it.
- No limit on automatic turns by default: `maxAutoTurns` in the host's `settings.json` now defaults to `0`, so sessions keep waking each other and carrying out each other's requests without anyone typing. Set a number to cap it again; a `settings.json` that sets `maxAutoTurns` keeps its value.
- Any MCP adapter instance can end, archive or reopen a meeting, not only the one that started it.

### Fixed

- The Codex background wait loads what a wake needs before it starts waiting, so an upgrade of the package (or a cleared npx cache) during the wait no longer makes the wake fail silently.

### Documentation

- An installation guide (`docs/INSTALL.md`) covers installing, upgrading and removing the host and the client, including the one-time Codex hook trust; a user guide (`docs/USER_GUIDE.md`) covers using them and holds the command, environment variable, `settings.json` and data directory reference. The README now gives an overview and links to them; each document covers its own topic instead of repeating the others.
- Every document has a Chinese version with the same sections: new Chinese installation guide, user guide, tools reference, host README, contributing and security docs, and the Chinese changelog now lists every version.

## [0.9.2] - 2026-10-24

### Fixed

- `n2n-nexus install` / `uninstall` write through a symlinked `settings.json` or `hooks.json` (account switchers such as PlanSwap share one file between config directories through a link) instead of replacing the link with a copy.
- A tray controlling the background service shows the address the service listens on (for example `http://0.0.0.0:5688 (LAN)`), not the loopback address it checks the service on.

## [0.9.1] - 2026-10-24

Clearer texts for the AI models that use n2n-nexus.

### Changed

- Tool descriptions tell `send` / `read` (direct messages between sessions) apart from `send_message` / `read_messages` (global chat and meetings), explain that ids in `read_messages`, `list_events` and meetings are MCP adapter instance ids rather than session ids, say which meeting becomes active and that only the starting instance can end, archive or reopen it, and describe `sync_project_assets` (create or replace), task metadata, `billing`, the strategy document and `get_global_topology` exactly.
- The MCP server instructions and the SessionStart introduction mention `reply`, `set_profile`, the hooks that direct messaging needs, and the difference between the two message kinds.
- Error texts say what to do: the no-agent-session error lists its causes (hooks missing, no new conversation since installing them, MCP server not named `n2n-nexus`, an expired binding: retry); meeting permission errors name the starting instance and the caller; schema validation errors list only the failing fields; `cancel_task` tells a missing task from a finished one; adapter and hook errors name n2n-nexus-host instead of the daemon.
- `get_global_topology` with an unknown `projectId` is an error instead of an empty graph; `host_maintenance` `prune` needs `count` ≥ 1 instead of removing nothing.

## [0.9.0] - 2026-10-23

Version 0.9.0 of both programs: the host is now `n2n-nexus-host`, a separate Go program, and the npm package `n2n-nexus` is the client only.

### Added

- `n2n-nexus-host`, the host rewritten in Go as one executable for Windows, macOS and Linux (amd64 and arm64). Without arguments it runs as a tray app: status, address and online sessions, open the log and data folders, LAN access on / off (on Windows it adds the TCP and UDP firewall rules after a UAC prompt; elsewhere it names the ports to allow), start at login (turned on the first time the tray runs), restart, quit; Chinese texts on a Chinese system, English otherwise. `serve` runs it in the foreground; `service install|uninstall|status` registers a boot service that runs as the installing user and restarts the host 5 s after it exits (Windows scheduled task, macOS LaunchDaemon, Linux systemd unit), and refuses to install while the tray runs the host; `autostart on|off` starts the tray at login. When a host already answers on the port (the service), the tray only controls it. One host runs per data directory.
- Installation through Homebrew (`brew install n2ns/tap/n2n-nexus-host`, built from source), Scoop (`scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`, `scoop install n2ns/n2n-nexus-host`) and archives on GitHub Releases (tags `host-v*`) with `SHA256SUMS` and build provenance (`gh attestation verify`). The binaries are not code-signed yet.
- `update_task`: update a task's `status`, `progress` (0–1), `result_uri`, `error_message` or `metadata`; returns the task.
- `contract/`: the protocol between host and client in JSON (`tools.json`, `hook.json`, `errors.json`), shipped in the npm package. `GET /health` reports the host's `contractVersion`, and `n2n-nexus doctor` checks that the host answers with the client's.
- LAN discovery: `NEXUS_ENDPOINT=discover` (or `--endpoint discover`) makes the MCP adapter and the hooks find a host by UDP broadcast on `NEXUS_DISCOVERY_PORT` (default 5688), cache it in `~/.n2n-nexus/discovered-endpoint` and look again when it cannot be reached. A host listening on a non-loopback address answers on its `discoveryPort`. When none answers, clients use the local endpoint `http://127.0.0.1:5688`.
- The SessionStart hook tells a new conversation its own session name and ID and which other sessions are not offline, so it can message them without being asked to look first.
- The MCP adapter sends server instructions describing how to find and message other AI sessions.
- Idle conversations are woken: `install` adds a second Stop hook (`n2n-nexus hook <client> --wait`) that waits up to an hour after a turn for new messages or notices and then starts a turn with them, through an `asyncRewake` hook in Claude Code and `codex queue` in Codex (`NEXUS_CODEX_COMMAND` overrides the command). The session shows as `listening` meanwhile; any new activity ends the wait. Run `n2n-nexus install <client>` again to add the hook. An unattended Claude session (`claude -p`, `CLAUDE_CODE_SESSION_ATTENDED=0`) skips the wait, so it exits as soon as it answers.
- Automatic turn limit: wakes, listening Stops and Stops held open for messages count as automatic turns, and after `maxAutoTurns` (host `settings.json`, default 8; `0` = no limit) since the user's last prompt, messages are stored but no longer wake or hold the conversation, so two AI sessions cannot keep waking each other. The announcement says `Automatic turn n of N`; the prompt that starts a woken turn does not reset the count.

### Changed

- **Breaking:** the npm package `n2n-nexus` is the client only (MCP adapter, `hook`, `install` / `uninstall`, `doctor`); `n2n-nexus daemon` is removed and the package no longer depends on `better-sqlite3`. Run the host with `n2n-nexus-host`.
- **Breaking:** storage is a new SQLite database, `nexus.db` in the host's data directory (`%LOCALAPPDATA%\n2n-nexus`, `~/Library/Application Support/n2n-nexus`, `$XDG_DATA_HOME/n2n-nexus` with default `~/.local/share/n2n-nexus`; `--root` or `NEXUS_ROOT` overrides it). Projects, assets and global docs are tables in it instead of files, every write is one transaction, and the schema is managed by numbered migrations. The data of earlier versions in `~/.n2n-nexus` is not imported and is left untouched.
- **Breaking:** the host has only four endpoints: `GET /health`, `GET /api/tools`, `POST /api/tools/call` and `POST /api/hook`. The project, message, global, meeting, task, event and maintenance REST endpoints are removed; every one of them has a tool of the same purpose.
- **Breaking:** `read_messages` needs an `instanceId` (the MCP adapter always sends one); calls without one no longer share an `unknown` read cursor.
- **Breaking:** host settings live in `settings.json` in the data directory (`host`, `port`, `discoveryPort`, `allowedHosts`, `rateLimit`, `rateBurst`, `maxAutoTurns`), overridden by command-line flags; the host reads no environment variable except `NEXUS_ROOT`. `NEXUS_HOST`, `NEXUS_DAEMON_PORT`, `NEXUS_ALLOWED_HOSTS`, `NEXUS_RATE_LIMIT`, `NEXUS_RATE_BURST` and `NEXUS_MAX_AUTO_TURNS` are gone; `NEXUS_DISCOVERY_PORT` remains for clients using `discover`.
- Hooks are rate limited per conversation and per client address, in buckets separate from tool calls.
- The host keeps data for a bounded time: events, read or expired direct messages and delivered notices for 30 days, finished tasks for 7 days; `host.log` rotates at 10 MB with 3 old files kept (the tray's own lines go to `tray.log`).
- The MCP adapter and the hooks never start a host. When none answers at a local endpoint, tool calls fail with a message saying to install and start `n2n-nexus-host`; at a remote endpoint, that it must be started on that machine. The hooks skip silently.
- `peers` lists only the sessions that are not offline; `includeOffline: true` adds the offline ones active in the last 24 hours, as before.
- An `idle` or `working` session without activity for 30 minutes is marked `offline`, since clients do not always send SessionEnd (finished or closed Codex threads stayed "online" forever); its next event brings it back. `peers` and the SessionStart introduction say that only `listening` sessions answer right away.

### Fixed

- A background wait counts as activity, so a session waiting longer than 30 minutes is not marked `offline` between two waits. A session with `listen` on no longer stays `listening` after its waits have ended, and a host restart resets sessions left `listening`, so they go `offline` after 30 minutes without activity like any other session.
- Starting, ending and reopening a meeting each update the meeting and the active meeting in one transaction.
- The event filter `action` matches the exact name or the exact `<action>.` prefix; it no longer ignores case or treats `_` and `%` as wildcards.
- A tool call the host does not answer within the request timeout fails on its own; the MCP adapter no longer drops the tool list and reconnects, which led clients to retry calls the host was still completing.
- Windows: `install <claude|codex>` finds `claude.cmd` / `codex.cmd` installed by npm, and the `--wait` hook wakes Codex installed that way. The script behind npm's shim runs with Node directly, never through cmd.exe, so a message text cannot run commands and keeps its line breaks; installing from an npx cache path is refused as on other systems.
- The `create_task` description no longer points to a tool that does not exist.
- The npm package includes the documents its README and guides link to (tools reference, security, contributing, Chinese assistant guide, 2025-12-29 meeting notes).

## [0.8.2] - 2026-10-22

### Fixed

- Two daemons starting together on a fresh storage root: the loser no longer crashes with `SqliteError: database is locked` before reaching the port; database initialisation waits for the other process and the loser exits on `EADDRINUSE` as intended.
- Reads of the file store (`get_project`, `search_projects`, topology, global docs) share a read-write lock with the writes, so a read during `rename_project` no longer returns an entry with empty docs and tech stack.
- `sync_project_assets` and `update_project` write the manifest and docs first and the registry last, and restore the files they wrote when a later step fails; a failed create no longer leaves a project without a directory, and a failed update no longer mixes new and old fields.
- Tasks whose timestamps were written before 0.6.0 (`YYYY-MM-DD HH:MM:SS`) are converted to ISO 8601 on startup, so they are no longer purged up to a day early.
- `n2n-nexus uninstall` (and `install`) report a failing `mcp remove` when the server is still registered in the client's configuration, exit with code 1 and say what to do; "not registered" is still ignored.

## [0.8.1] - 2026-10-22

### Added

- `n2n-nexus install <claude|codex>` writes the `node` found on PATH when it is the running binary, instead of `process.execPath`, the resolved version directory (nvm, Homebrew Cellar, fnm, ...) that disappears when Node is upgraded. `--node <path>` chooses the path explicitly; it must exist, run and satisfy `engines.node`. `install` prints the path it wrote and warns when it is in a version directory.
- `n2n-nexus doctor [claude|codex]`: checks that the Node path and the entry script in the installed hook and MCP commands exist and run, and says how to fix them.

### Fixed

- Daemon responses are decoded as streaming UTF-8; a multi-byte character split across two chunks no longer turns into U+FFFD.
- `rename_project` renames the directory, the manifests and the registry entry as one unit and rolls everything back when a step fails.
- `host_delete_project` fails, and keeps the registry entry, when the project files cannot be removed.
- `upload_project_asset` checks that the project exists inside the write lock, so an upload racing a delete no longer recreates the deleted project. It returns the name the asset is saved under, and a file name that sanitizes to `.` is rejected.
- `listen({ on: false })` ends a Stop hook that is already waiting instead of letting it run to the timeout.

### Upgrade notes

- Run `n2n-nexus install claude` and/or `n2n-nexus install codex` again so the hooks and the MCP command use a stable Node path.

## [0.8.0] - 2026-10-21

### Added

- Every Claude Code and Codex conversation is its own session, `claude:<id>` or `codex:<id>`, using the ID the client assigns. Resuming a conversation, restarting the adapter and sub-agents keep it.
- Direct-message tools `peers`, `send`, `read`, `reply`, `listen` and `set_profile`. Tool calls name their conversation through the MCP request `_meta` (Claude Code `claudecode/toolUseId`, bound by a PreToolUse hook; Codex `sessionId`), never through arguments.
- `n2n-nexus hook <claude|codex>` and `POST /api/hook`: client hooks keep each conversation's status (working, idle, listening, offline) and announce new messages when the user sends a prompt, after each tool call and once before the turn ends. Notifications carry only the sender and first line; the text arrives through `read`, as tool output.
- `listen`: a conversation that ends its turn keeps waiting up to 590 seconds and continues when a message arrives. `send(notifyWhenIdle)` gives one notice when the recipient next ends its turn or goes offline. Unread messages expire after 24 hours and the sender is told.
- `n2n-nexus install <claude|codex> [--endpoint <url>]` and `uninstall`: write or remove the hooks and the MCP server in the client's user configuration, merging with existing settings. Codex hooks must be trusted once with `/hooks`.
- The adapter and the hooks start a daemon in the background when nothing listens at a local endpoint (`127.0.0.1` or `localhost`); its log is `~/.n2n-nexus/daemon.log`.

### Removed

- `list_sessions`, `update_session`, `read_inbox`, `get_message` and `acknowledge_message`, the `to`, `replyTo` and `ttlMs` parameters of `send_message`, `POST /api/sessions/register` and `POST /api/sessions/disconnect`, and the adapter's random session ID and heartbeats. `send_message` now posts only to meetings and global chat.

### Fixed

- Two daemons starting together on a fresh storage root no longer crash the second one in the strategy migration; it exits on `EADDRINUSE`.

### Upgrade notes

- Run `n2n-nexus install claude` and/or `n2n-nexus install codex` after upgrading; direct messages need the hooks. Other MCP clients keep every tool except direct messages.
- Sessions and direct messages from 0.7.0 are not migrated; their tables are no longer read.

## [0.7.0] - 2026-10-20

### Added

- Session discovery with `list_sessions` and `update_session`: each MCP connection has a distinct session ID, a display name, optional project association, an incoming-message policy and heartbeat-based presence. Connections sharing an instance ID have separate inboxes.
- Direct messages through `send_message(to, replyTo?, ttlMs?)`, plus `read_inbox`, `get_message` and `acknowledge_message`. Receipts distinguish accepted, fetched, acknowledged, replied, refused and expired messages. Unacknowledged fetched messages remain retrievable, and replies link back to the original message.

### Changed

- MCP adapters register their connection identity and maintain it with heartbeats. Stable instance IDs continue to identify legacy shared-message cursors and meeting permissions.
- Updated compatible runtime and development dependencies, including Zod, ESLint, typescript-eslint, Vitest and Lefthook.

### Fixed

- Strategy migration now records completion and preserves conflicting documents, preventing later user documents from being mistaken for legacy data and deleted on restart.
- Interrupted HTTP responses now reject the pending request instead of leaving connection attempts, tool calls or shutdown waiting indefinitely.
- Malformed Host headers and request URLs return HTTP 400 without terminating the daemon; existing browser and Host restrictions remain in effect.
- Concurrent attempts to rename one project to different destinations no longer both report success or record a rename that did not happen.
- MCP adapters can connect to IPv6 daemon endpoints without treating the address brackets as part of a DNS hostname.
- Task expiry preserves timestamp milliseconds so maintenance does not fail tasks before their TTL has elapsed.

### Upgrade notes

- Upgrade the daemon first, then restart the MCP adapters on 0.7.0. New adapters require the daemon's session registration endpoints before executing tools. Existing meeting and global-message operations remain available with the upgraded daemon.
- Inboxes are per MCP connection. Host chats sharing one connection share its inbox, and restarting the adapter creates a new session rather than inheriting the previous inbox.
- Incoming messages require an explicit `read_inbox` call; this release does not automatically wake models. Online presence indicates a recent heartbeat, fetching does not prove processing, and acknowledgement confirms receipt rather than completion of work.

## [0.6.0] - 2026-10-16

### Added

- Rate limiting, which the MCP tools specification requires of servers: a token bucket per instance ID (default 20 calls/s, burst 60; `NEXUS_RATE_LIMIT`, `NEXUS_RATE_BURST`, `0` disables) plus one per client address at five times that, since instance IDs are self-declared. Requests without an instance ID (most REST reads) are limited per address only. Over the limit the daemon answers `429` with `Retry-After`; the MCP adapter reports it to the model as a tool error and keeps the connection. `/health` and `GET /api/tools` are exempt.

- Structured tool results: every successful call returns `structuredContent` alongside the JSON text, and the eleven data-returning tools publish an `outputSchema`. Result shapes are zod contracts in `src/daemon/tool-outputs.ts` that type the handlers; a test calls all tools through the adapter for both protocol eras and checks each result against its contract. Publishing schemas for write tools as well would have grown `tools/list` from about 14 KB to 27 KB for a one-line acknowledgement, so they are left out (22 KB with the read schemas).

- A display `title` on every tool (for example "Delete Project"), which MCP clients show instead of the raw tool name.

- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool, so clients can tell read-only tools from ones that overwrite or delete data and ask the user before the latter.

- `list_meetings` tool and `GET /api/meetings`: list meetings with status, initiator, participants, message and decision counts and summary. Assistants could only reach a meeting whose id they already knew.

- `get_project` tool and `GET /api/projects/:projectId`: read a project's full manifest and internal docs. Assistants could sync them but had no tool to read them back.

- `get_global_strategy`, `list_global_docs` and `get_global_doc` tools. Assistants could write the strategy and shared docs but had no tool to read them back; only the REST API could.

- `list_events` tool and `GET /api/events`: a structured activity log (actor, action, target, detail) of every state change made through the daemon.

### Removed

- `register_session_context` and `POST /api/session/register`. The daemon kept an in-memory "current project" per instance that only `upload_project_asset` used; MCP 2026-07-28 makes protocol sessions go away and recommends passing cross-call state as explicit tool arguments. `upload_project_asset` now takes `projectId` and checks that the project exists.

- Leftovers from the pre-0.5 election architecture and other dead code: unused constants (`PORT_RANGE_*`, `HANDSHAKE_TIMEOUT`, `HEARTBEAT_INTERVAL`), `hasFlag`, `HubConfig`/`ToolContext`/`MeetingState` types, `isSqliteAvailable`, `getTasksByMeeting`, `getActiveTaskCount`, `NexusClient.health`, the never-used `archives/` directory and `tasks.json` path, `suggestedSyncTargets` (parsed a `name@project` instance-id format that no longer exists), the undocumented `NEXUS_PORT` alias of `NEXUS_DAEMON_PORT`, and `migrations/003_add_tasks_table.sql` (the schema lives in `sqlite.ts`). The two `getRootPath` implementations are merged into `config/paths.ts`, so `--root ./relative` and `~` are resolved consistently. `billing` is now preserved on read and patch instead of being dropped.

- JSON meeting-store fallback (`store.ts`, `meetings.ts`) and the `/api/storage/info` endpoint. SQLite is required; the daemon no longer reports a "degraded" storage mode.

### Fixed

- `NEXUS_RATE_BURST` between 0 and 1 made every call fail with 429 forever, and `NEXUS_RATE_BURST=0` silently disabled rate limiting. The burst is now at least 1, and only `NEXUS_RATE_LIMIT=0` disables limiting.

- Manifests written by earlier releases (whose `update_project` stored patches unvalidated) could hold nested relations, endpoints or API specs with missing or extra fields, which made `get_project` and `get_global_topology` fail outputSchema validation on 2026-07-28 clients. Reads now normalize stored manifests: invalid entries are dropped, missing strings become empty, an unknown relation type reads as `related`. The files are not rewritten.

- Result contracts were only enforced by TypeScript, which ignores extra fields on returned variables, so a new field in stored data could reach clients as structuredContent that violates the published `outputSchema`. Every result now passes through its zod contract on the way out: undeclared fields are stripped, and a result that cannot meet the contract becomes a server error.

- If a tool call lost the daemon while a reconnect attempt that had just succeeded was still notifying the client, the attempt then stopped the retry loop although the adapter was disconnected again; every later call answered "Daemon is not ready yet" until the IDE restarted. The loop now stops only if the connection is still up.

- The adapter's reconnect loop used a 3-second `setInterval` while each attempt could take up to the 5-second request timeout, so a hung daemon accumulated overlapping requests. Each attempt is now scheduled only after the previous one finishes.

- `rename_project`, `cancel_task`, `end_meeting`, `archive_meeting` and `reopen_meeting` were annotated `destructiveHint: false`, which MCP reserves for purely additive tools; clients could run them without asking the user. They are now marked destructive.

- When the daemon reported a tool as unknown (for example after an upgrade the adapter did not notice), the adapter returned `-32602` but kept offering the tool in `tools/list`. It now re-fetches the tool list and sends `list_changed` if it differs.

- The adapter fetched the daemon tool list before it began reading stdin. A daemon that accepted connections but never answered held `server/discover` and `initialize` for the 5-second client timeout, long enough for probing clients to misclassify the server as legacy, and delayed exit after stdin closed. The adapter now serves immediately and fetches in the background.

- On 2026-07-28 connections, a request without `io.modelcontextprotocol/clientInfo` (only a SHOULD in the spec) got an instance ID without the IDE name, so one client could appear as two instances with split unread cursors and meeting permissions. The adapter now keeps the first client name seen on the connection.

- Calling a tool the adapter does not know returned a tool result with `isError: true`. The MCP specification classifies an unknown tool as a protocol error; the adapter now answers with JSON-RPC error `-32602` (Invalid Params), also when the daemon reports the tool as unknown.

- The MCP adapter did not exit when the IDE closed its stdin: while the daemon was unreachable the 3-second reconnect timer kept the process alive indefinitely, leaving orphaned adapters. The adapter now shuts down and exits when stdin ends, as the stdio transport specification requires.

- Project and document ids that match `Object.prototype` keys were mishandled: `register_session_context({ projectId: "constructor" })` reported success for a project that did not exist, and a project or doc named `__proto__` was silently lost because assigning it rewrote the map's prototype. The registry and docs index are now prototype-free maps.

- `sync_project_assets` wrote the manifest and the internal docs as two separately locked steps, so a concurrent `host_delete_project` could run between them and leave a project directory on disk that the registry no longer knew about. Both writes now happen in one critical section.

- `npm run build` now clears `build/` first. `tsc` alone left compiled files of deleted sources behind (for example `build/storage/store.js`), and `npm publish` would have shipped them.

- `ttl` on tasks was stored but never enforced and `cleanupTasks` was never scheduled, so the tasks table grew forever. The daemon now runs task maintenance at startup and hourly: pending/running tasks past their TTL are marked `failed` (`TTL expired`) and finished tasks older than 7 days are purged. The `tasks_updated_at` trigger is dropped: it overwrote the ISO 8601 `updated_at` written by `updateTask` with `datetime('now')` in a different format, so age comparisons mixed two timestamp formats.

- `update_global_strategy` wrote `global/docs/strategy.md` while the documentation described `global/blueprint.md` as the master strategy document, and two initializers created `blueprint.md` with different placeholder text. The tool now writes `blueprint.md`; `GET /api/global/strategy` reads it. On first start an existing `strategy` global doc is moved into `blueprint.md` (unless a non-placeholder blueprint is already there) and removed from the docs index.

- `sqlite.ts` registered SIGINT/SIGTERM handlers at import time that called `process.exit(0)` immediately, so the daemon's graceful `server.close` never ran. Signal handling now lives in the daemon entry point: stop accepting connections, finish in-flight requests, close the database, exit.

- Tool arguments were never validated: the daemon cast whatever arrived and let SQLite or the filesystem fail later (for example `category: "SYSTEM"` surfaced as a `CHECK constraint failed` 500). Every tool now has a zod contract in `src/daemon/tools.ts`; the JSON Schema served to MCP clients is generated from it and the same contract validates tool calls and REST endpoints, returning 400 with the failing field. `patch` for `update_project` rejects unknown fields, `create_task` checks that `source_meeting_id` exists, and SQLite foreign keys are enforced.

- The MCP adapter generated a random instance ID on every start, so an IDE restart reset unread cursors and left meetings that no one could end or archive (only the initiator may). The default is now `mcp-<hostname>-<hash of working directory>-<IDE name>` (IDE name from the MCP handshake), stable per machine, workspace and IDE. `reopen_meeting` applies the same initiator check as `end_meeting` and `archive_meeting`.

- The daemon accepted any HTTP request, so a web page open in the user's browser could call `host_delete_project` on the local daemon with a cross-site `text/plain` POST. Requests carrying a browser `Origin` or cross-site `Sec-Fetch-Site` header are refused (403), POST requires `Content-Type: application/json` (415), and request bodies are capped at 16 MB (413) instead of being buffered without limit. The `Host` header must be an IP literal, `localhost`, `host.docker.internal` or a name in `NEXUS_ALLOWED_HOSTS`, which blocks DNS-rebinding pages that would otherwise reach the daemon as same-origin GETs.

- The MCP adapter treated every failed tool call (unknown task, closed meeting, permission denied, ...) as the daemon going away: it cleared the tool list, notified the IDE and entered the reconnect loop. Transport failures and tool failures are now distinct (`NexusTransportError` vs `NexusToolError`); only the former triggers reconnection, and tool failures are returned as `isError` results. `POST /api/tools/call` answers 404 for an unknown tool and 400 when the tool rejects the call.

### Changed

- The MCP adapter moved from `@modelcontextprotocol/sdk` 1.x (protocol 2025-11-25) to the v2 SDK (`@modelcontextprotocol/server` 2.3) and serves both the stateless 2026-07-28 revision and 2025-era clients over stdio via `serveStdio`. 2026-07-28 clients get `server/discover`, the per-request `_meta` envelope and list-changed notifications on `subscriptions/listen`; the instance ID reads the client name from the request envelope. The first `tools/list` waits up to one second for the startup daemon fetch, so it is complete whenever a local daemon is up, while `server/discover` and `initialize` are answered immediately even if the daemon hangs.

- Tools without parameters (`get_global_strategy`, `list_global_docs`) publish `{ "type": "object", "properties": {}, "additionalProperties": false }`, the form the MCP specification recommends, and reject unexpected arguments.

- `send_message` routing no longer depends on `register_session_context`: a message goes to `meetingId` when given, else to the active meeting, else to global chat. `POST /api/messages/send` uses the same rule (its `source` parameter is gone) instead of a separate code path with different defaults.

- Global chat moved from `global/discussion.json` into SQLite. `read_messages` without `meetingId` is now truly incremental per instance (the tool description had promised this), appends no longer rewrite the whole file, and `host_maintenance` reports how many messages were removed. On first start the daemon imports an existing `discussion.json` (categories outside the five known values become unset) and renames it to `discussion.json.migrated`.
- Daemon state changes (session register, project sync/rename/delete, meeting end, ...) are recorded as events instead of `SYSTEM` lines in the global chat.

- `sync_project_assets`, `update_project`, `rename_project`, and `host_delete_project` now run synchronously and return their result directly instead of a `task_id` to poll. The operations take milliseconds; the background-task wrapper only added a polling round-trip and let the work race with other requests.

- Require Node.js 22.14+ on the 22.x release line, or Node.js 23.6+ and update MCP SDK, SQLite, and test dependencies to their latest compatible stable releases.

## [0.5.0] - 2026-06-14

### 🏗️ Daemon + MCP Architecture (Breaking Refactor)

Complete architectural rewrite. The old Host/Guest election mechanism is replaced by a standalone HTTP daemon as the single source of truth.

**Why**: The election model assumed all AI instances share the same `localhost`. This fails across Windows/WSL/VM environments (different localhost namespaces) and whenever the "Host" IDE is closed. Split-brain risk was unacceptable.

#### New Architecture
- **`n2n-nexus daemon`** — standalone HTTP server; user starts it manually; owns all data, tool definitions, and business logic; never dies when an IDE closes
- **`n2n-nexus mcp`** — stateless MCP proxy; IDE starts it via `npx`; fetches tool list from daemon (`GET /api/tools`), forwards every tool call (`POST /api/tools/call`)
- **Cross-environment**: set `NEXUS_ENDPOINT` to bridge Windows/WSL/VM or remote machines

#### MCP Behavior
- Starts with empty tool list; background retry loop (every 3 s) until daemon is reachable
- On connect: sends `notifications/tools/list_changed` → IDE reloads tools automatically
- On daemon disconnect: clears tool list, notifies IDE, resumes retry loop
- No hardcoded tool names in MCP — daemon upgrades are transparent

#### Deleted (not needed in new architecture)
- `src/network/` — election, Host, Guest
- `src/auth/` — Host/Guest permission gates
- `src/tools/handlers/`, `src/tools/definitions.ts`, `src/tools/schemas/`
- `src/resources/` — MCP Resources layer
- `src/server/resources.ts`, `src/server/tools.ts`

#### Storage layer unchanged
`src/storage/` is kept as-is. SQLite WAL mode is safe because only the daemon process writes directly; MCP processes go through HTTP, serializing all writes naturally.

---

## [0.4.2] - 2026-01-14
### 🛡️ Stability & Automation
- **Lefthook Integration**: Added high-performance Git hooks. Now automatically runs `lint` on commit and `build + test` on push to ensure zero regressions.
- **E2E Test Stability**: Fixed a critical hang in subprocess logging by implementing `stdout` draining.
- **CLI Port Override**: Fixed a bug where the `--port` flag was ignored during Host Election.
- **Non-blocking Handshake**: Optimized Stdio connection to prevent blocking election logic.

## [0.4.1] - 2026-01-14
### ✨ Developer Experience & Observability
- **MCP Logging Protocol**: Implemented standard `notifications/message` protocol support. Debug logs now appear directly in the IDE's "Model Context Protocol" output channel.
- **Improved Stdio Handling**: Verified and strictly enforced JSON-RPC compliance on `stdout` to prevent IDE integration issues.
- **Better Error Reporting**: Boot failures now include more descriptive context on `stderr`.

## [0.4.0] - 2026-01-14
### 🚀 High Availability & Scalability
- **Failover Mechanism**: Implemented automatic Guest-to-Host promotion. If the Host process dies, a Guest detects usage of the port/lock and takes over immediately with data persistence.
- **Progressive Discovery**: Added `search_projects` tool. Allows AI to find relevant projects by query without loading the entire 1000+ project registry, reducing context usage.
- **Immediate Handshake**: Implementing Request Buffering allows the server to accept IDE requests immediately (<10ms) while the Host Election runs in background (~300ms). Fixes startup race conditions.
- **Stability**: Added explicit E2E tests for process failover (`tests/failover.test.ts`) and request buffering (`tests/buffered_requests.test.ts`).

## [0.3.9] - 2026-01-11
### 🚀 Online First Architecture
- **Performance**: Removed top-level blocking await for election. Server now starts in <300ms (Online First), reducing startup time by 99% in congested networks.
- **Stability**: Fixed "Timeout" errors in MCP clients (Cursor/Claude) by ensuring `tools/list` is available immediately before Host Election completes.
- **Race Condition Fix**: Implemented explicit server shutdown before transitioning from Local to Guest mode to prevent Stdio stream conflicts.
- **Refactor**: Moved `isHost` logic from static config to dynamic `updateConfig` flow.


## [0.3.5] - 2026-01-10
### Protocol & Stability
- **Fix (Zombie Host)**: Implemented "Intelligent Retry" and "Re-Election" logic. If a Guest repeatedly connects to a Zombie Host (handshake OK, SSE broken), it will now automatically trigger a re-election process, blacklist the bad port, and promote itself to Host on a new port if necessary.
- **Refactor**: Enabled dynamic role switching (Guest -> Host) without process restart.

## [0.3.4] - 2026-01-10
### Protocol & Stability
- **New Handshake Protocol**: Introduced `POST /nexus/handshake` to replace legacy `/hello`. Supports strict versioning (Client/Server) and robust Host detection.
- **Global Error Safety Net**: Implemented `uncaughtException` and `unhandledRejection` handlers to prevent process exits from background task errors, ensuring high availability of the Hub.
- **Fix (EOF Error)**: Resolved "Connection Closed: EOF" crashes caused by non-idempotent SQLite initialization during repeated tool calls.
- **Fix (Zombie Host)**: Eliminated infinite retry loops by improving Guest's host detection logic.
- **Test Coverage**: Added `guest_connection.test.ts` to verify Guest-Host SSE integration.

## [0.3.3] - 2026-01-10
### 🔄 Zero-Config Persistence
- **XDG Base Directory Support**: Moved valid storage location from ephemeral `node_modules` to system-standard user data paths:
  - **Linux/WSL**: `~/.local/share/n2n-nexus`
  - **Windows**: `%APPDATA%\n2n-nexus`
  - **macOS**: `~/Library/Application Support/n2n-nexus`
- **Data Persistence**: Data now survives `npx` cache clearing, project deletion, and re-installations.
- **Bind Address**: Changed default listener to `0.0.0.0` to support WSL Mirror Mode networking.
- **Identity Safety**: Default "Assistant" ID now appends a random suffix (e.g., `Assistant-x9a2`) to prevent conflicts when multiple empty IDEs connect.

## [0.3.8] - 2026-01-11

### Fixed
- **Guest Proxy Framing**: Implemented proper message framing (newline-delimited JSON buffer) in Guest-to-Host proxy. This resolves "context deadline exceeded" timeouts in IDEs where stdin pipes fragment JSON-RPC messages.

## [0.3.7] - 2026-01-08
### Security & Stability
- **Security**: Fixed potential URL parameter injection in Guest proxy connection URL.
- **Stability**: Refactored host election fallback loop from async recursion to `while(true)` to prevent long-term stack overflow.
- **Refactor**: Improved code structure in `config.ts` for better maintainability.

## [0.3.1] - 2026-01-08
### Fixed
- **Critical**: Recursive stack overflow in Guest proxy reconnection logic (partial fix).
- **Critical**: Server crash when fallback port binding fails (now retries with backoff).
- **Performance**: Optimized port scanning with batch concurrency (56s -> 3s scan time).
- **Config**: Expanded port range to 5688-5800 (113 ports).

## [v0.3.0] - 2026-01-08

### 🌐 Global Hub Architecture (Zero-Config Multi-IDE Collaboration)

This release introduces a fully automatic Host election and Global Hub architecture, enabling seamless multi-IDE collaboration without any configuration.

#### Automatic Host Election (Port-Based)
- **Port Range 5688-5700**: First instance to bind becomes Host, others become Guests.
- **Probe-First Strategy**: Guests scan for existing Host before attempting to bind, eliminating race conditions.
- **Hello Handshake**: `/hello` endpoint validates Nexus identity, distinguishing from other services.
- **10s Failover Window**: On bind failure, Guests wait 10 seconds then re-probe to join the winner.

#### Global Hub (SSE-Based Communication)
- **Single Hub Architecture**: All IDEs (regardless of project) connect to the same Host for cross-project collaboration.
- **Stdio-to-SSE Proxy**: Guests transparently forward IDE traffic to Host via SSE.
- **Multi-Session Routing**: Host maintains session map for concurrent Guest connections.
- **Storage Path Inheritance**: Host broadcasts `rootStorage` path; Guests inherit it for seamless failover.

#### Heartbeat & Watchdog (High Availability)
- **Host Heartbeat**: Host sends `: ping` every 30 seconds to keep connections alive.
- **Guest Watchdog**: Guests monitor activity; if silent for 60 seconds, trigger automatic re-election.
- **Hot Failover**: Surviving Guests automatically promote to new Host using inherited storage path.

#### Terminology Refactoring
- **Moderator → Host**: All code, tests, and documentation updated.
- **`isModerator` → `isHost`**: API and config properties renamed.
- **`moderator_*` → `host_*`**: Tool names updated (e.g., `host_maintenance`).

#### Zero-Config Experience
- **`--id` Deprecated**: Instance ID now auto-derived from project folder name.
- **`--host` Removed**: Host role determined automatically by port binding.
- **Simplified CLI**: Just `npx n2n-nexus` to get started.

| Metric | Before | After |
|--------|--------|-------|
| Required CLI Args | 2-3 | 0-1 |
| Manual Host Setup | Required | Automatic |
| Multi-IDE Sync | File-based | SSE Real-time |
| Failover Time | Manual restart | < 10 seconds |

#### Test Coverage
- New `election.test.ts` with 9 test cases covering probe, bind, and race scenarios.
- All 55 tests passing.

## [v0.2.1] - 2026-01-01

### 🚀 Token Economy Deep Optimization

This release focuses on reducing context window consumption when AI loads the MCP server.

#### Tool Definition Optimization (-49% Token Reduction)
- **Hand-Crafted Schemas**: Replaced `Zod.toJSONSchema()` with manually optimized `definitions.ts`.
- **Removed $schema Spam**: Eliminated redundant `$schema` declarations per tool (~50 chars saved per tool).
- **Concise Descriptions**: Reduced average description length by 50%.
- **Hidden Internal Tools**: `update_task` (marked `[INTERNAL]`) excluded from public `ListTools`.

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Tool Definitions | 10,241 chars | 5,237 chars | **-49%** |
| Approx Tokens | ~2,560 | ~1,310 | **-1,250 tokens** |

#### Incremental Message Reading
- **Read Cursors Table**: New `read_cursors` SQLite table tracks each IDE's last read message ID per meeting.
- **Auto-Increment**: `read_messages` automatically returns only unread messages based on `instanceId`.
- **Zero Config**: No `afterId` parameter needed - cursor managed entirely server-side.
- **Response Enhancement**: Returns `{ newMessages: N, messages: [...] }` for easy verification.

#### Context7-Style Progressive Loading
- **`get_global_topology` Upgrade**:
  - **Default (List Mode)**: Returns lightweight summary `{ totalProjects, totalEdges, projects: [{id, name}] }`.
  - **Focused Mode**: Pass `projectId` to get detailed subgraph for that specific project.
- **`listResources` Optimization**:
  - **O(1) Scaling**: Resource list size is now constant regardless of project count.
  - **Static Resources**: Fixed 8 core resources (chat, registry, docs, meetings, etc.).
  - **Template-Based Projects**: Individual projects no longer dynamically listed; use templates instead.
  - **Discovery Flow**: AI reads `hub/registry` → discovers project IDs → constructs URI from template.

| Scenario | Before | After |
|----------|--------|-------|
| 0 projects | 8 resources | 8 resources + 4 templates |
| 20 projects | 28 resources | 8 resources + 4 templates (fixed) |
| 50 projects | 58 resources | 8 resources + 4 templates (fixed) |

#### Documentation
- Updated `README.md` with new tool behaviors (`[Incremental]`, `[Progressive]`).
- Updated `ASSISTANT_GUIDE.md` to v0.2.1 with "渐进式发现，增量读取" principle.
- Reorganized Resources section with Core Resources + Resource Templates structure.

## [v0.2.0] - 2025-12-31

### 🚀 Task Primitive System (Phase 2 & 3)
- **Async Deepening**: Critical blocking operations (`rename_project`, `moderator_delete_project`) migrated to the Task primitive with background cascading updates.
- **Traceability**: All tasks now support `source_meeting_id` to link execution back to meeting decisions.
- **Progressive UI**: Added `progress` tracking (0.0-1.0) and `result_uri` for structured task output.
- **Lifecycle Tools**: Added `create_task`, `get_task`, `list_tasks`, `update_task`, and `cancel_task`.

### 🛡️ Type Safety & Security
- **Defense-in-Depth**: Implemented secondary permission gates inside `handleRemoveProject` and `handleModeratorMaintenance` for maximum project isolation.
- **Meeting Hardening**: `end_meeting` and `archive_meeting` are now strictly **Moderator-only**.
- **Zod integration**: All tool definitions migrated to strictly-typed Zod schemas with regex path-traversal protection.
- **Infrastructure**: Modernized toolchain to **TypeScript 5.9.3**, **Vitest 4.0.16**, and **ESLint 9.39.2**.

### ✂️ Code Diet (Architectural Cleanliness)
- **The Great Purge**: Removed 6 redundant tools (`list_projects`, `read_project`, `list_global_docs`, `read_global_doc`, `list_meetings`, `read_meeting`) in favor of Resource URIs.
- **Native Zod 4 Schemas**: Removed `zod-to-json-schema` dependency; now using native Zod 4 `toJSONSchema()` generation.

## [v0.1.9] - 2025-12-30

### 🛡️ Collaboration & Security
- **Initiator-only Permissions**: Implemented restricted access for `end_meeting` and `archive_meeting`.
- **Session Presence Awareness**: Automated `[ONLINE/OFFLINE]` status messages in global logs.
- **Clean Tool Naming**: Finalized transition to `send_message` and `read_messages`.

### 🌐 Resource Namespacing (MCP 2025 Standard)
- **Unified Authority**: All core resource URIs migrated to `mcp://nexus/`.
- **New Resources**: Added `mcp://nexus/status` and `mcp://nexus/active-meeting`.

## [v0.1.8] - 2025-12-30

### 🎯 Meeting Architecture (Phase 1 & 2)
- **Hybrid Storage Backend**: Automatic selection between **SQLite** (preferred) and **JSON Fallback**.
- **SQLite Engine**: Powered by `better-sqlite3` with **WAL mode** for high-concurrency and multi-process safety.
- **New Lifecycle Entity**: `MeetingSession` replaces monolithic chat logs with discrete sessions.
- **Lifecycle Tools**:
  - `start_meeting(topic)`: Creates dedicated session with unique ID and random entropy.
  - `end_meeting(meetingId?, summary?)`: Closes meeting, collects decisions.
  - `archive_meeting(meetingId)`: Moves sessions to historical archives.
  - `list_meetings(status?)`: Filtered discovery of sessions.
  - `read_meeting(meetingId)`: Detailed retrieval of history, participants, and decisions.

### 🏗️ API & Storage Improvements
- **Structured JSON Responses**: Meeting tools now return machine-readable JSON for better agent integration.
- **Smart Auto-Routing**: Global discussion messages are automatically routed to active meetings.
- **ID Generation**: Robust slug generation with Base64 fallback for non-ASCII topics (Chinese/Unicode).
- **Concurrency Control**: Shared `AsyncMutex` utility and native SQLite locking.
- **Status Reporting**: `mcp://nexus/status` now reports `storage_mode` and `is_degraded` flags.

### 🧪 Quality Assurance
- **Comprehensive Test Suite**: Added 24+ integration and stress tests (100% Green).
- **Concurrency Stress Tests**: Validated data integrity under rapid message bursts.
- **Fallback Verification**: Confirmed system stability when native modules are unavailable.

### 🛡️ Security
- **Hardened Project Deletion**: Renamed `delete_project` to `moderator_delete_project` and enforced explicit moderator validation to prevent unauthorized project destruction.
- **Path Sanitization**: Enhanced error handling to strip absolute local file paths from MCP error messages.

### 📄 Resources & Documentation
- **New Resource**: Added `mcp://nexus/active-meeting` for instant access to the current meeting transcript and decisions.
- **Improved Tooling UX**: Documented return value structures and administrative requirements in tool definitions.
- **Manuals**: Updated `ASSISTANT_GUIDE.md` and both README versions with new admin tool documentation and Phase 2 best practices.

## [v0.1.7] - 2025-12-30

### ⚙️ CLI Simplification
- **Moderator flag**: Replaced `--moderator-id <id>` with simple `--moderator` boolean flag.
  - Moderator: `--id Master-AI --moderator`
  - Regular AI: `--id Assistant-AI` (no extra flag needed)

### ✅ Tests
- Added session resource tests for role verification (Moderator/Regular).
- All 17 unit tests passing.

## [v0.1.6] - 2025-12-29

### 🔒 Concurrency Safety
- **AsyncMutex Lock**: Implemented mutex-based concurrency control to prevent race conditions during simultaneous file writes.
- Protected write operations:
  - Discussion: `addGlobalLog()`, `pruneGlobalLogs()`, `clearGlobalLogs()`
  - Registry: `saveProjectManifest()`, `renameProject()`, `deleteProject()`

### 📦 Schema v2.0
- **Manifest Schema Enhancements**: Added new optional fields for cross-project collaboration and compatibility:
  - `apiDependencies`: Map of projectId to version constraint (e.g., `">=v2.1"`)
  - `gatewayCompatibility`: Gateway version compatibility string
  - `api_versions`: Feature-level API versions
  - `feature_tier`: Capability category declaration for interoperability

## [v0.1.5] - 2025-12-29

### 🚀 Major Features
- **Project ID Naming Convention**: Enforced `[prefix]_[technical-name]` standard with 13 type prefixes (web_, api_, chrome_, vscode_, mcp_, android_, ios_, flutter_, desktop_, lib_, bot_, infra_, doc_).
- **MCP Prompts Capability**: Added `init_project_nexus` prompt for guiding AI through proper project registration workflow.
- **delete_project Tool**: New admin tool for complete project removal (manifest, assets, registry entry).

### 🔒 Guardrails
- Added `validateProjectId()` with runtime regex validation in `handleRegisterSession`, `handleSyncProjectAssets`, and `handleRenameProject`.
- Projects with invalid ID formats are now rejected at the API level.

### ✨ Enhancements
- Resource names now display project type icons (e.g., "🌐 Website: web_example.com").
- Handler unit tests expanded to cover delete, rename, and validation scenarios.

### 📄 Documentation
- Added "Project ID Conventions" section to README.md.
- Updated tool descriptions with Prefix Dictionary guidance.

## [v0.1.4] - 2025-12-29

### 🐛 Bug Fix
- Added shebang (`#!/usr/bin/env node`) to fix npx execution on Windows.

## [v0.1.3] - 2025-12-29

### 🔧 CI/CD
- Switched to npm Trusted Publishing (OIDC) - no more NPM_TOKEN needed.
- Upgraded to Node.js 22 for npm 11.5.1+ support.
- Added `--provenance` flag for supply chain security.

## [v0.1.2] - 2025-12-29

### 🔧 Refactoring
- Modularized codebase into `tools/`, `resources/`, and `storage/` modules.
- Reduced `index.ts` from 535 to 115 lines.
- Moved tests from `src/__tests__/` to top-level `tests/` directory.

### 📦 CI/CD
- Changed GitHub Actions trigger from `release` to tag push (`v*`).

### 📄 Documentation
- Added npm downloads badge.
- Fixed repository URLs to `n2n-nexus`.

## [v0.1.1] - 2025-12-29

### 📦 npm Release
- Published to npm as `n2n-nexus`.
- Updated README with `npx` configuration for easy MCP integration.
- Added CLI arguments documentation table.

## [v0.1.0] - 2025-12-29

### 🚀 Major Features
- **Project Asset Hub**: Centralized storage for Project Manifests, Internal Docs, and Assets (Images/Files).
- **Communication Channels**:
    - `mcp://chat/global`: Real-time inter-agent messaging stream.
    - `post_global_discussion`: Broadcast tool for coordination.
- **Topology Engine**:
    - `get_global_topology`: Auto-generates dependency graphs based on manifest `relations`.
- **Global Knowledge Base**:
    - New `docs/` directory structure for shared standards.
    - Tools: `sync_global_doc`, `read_global_doc`, `list_global_docs`.
- **Self-Healing Storage**:
    - Automatic repair of corrupted JSON registries or logs.
    - Safe-defaults for missing configurations.

### 🛠️ Tooling
- Added `update_project` for partial manifest patches.
- Added `rename_project` with auto-cascading reference updates across all projects.
- Added `register_session_context` for IDE session binding.
- Added `moderator_maintenance` for log pruning.

### 📚 Documentation
- Updated `README.md` with complete architecture diagrams and data persistence details.
- Added `ASSISTANT_GUIDE.md` for AI-to-AI operational protocols.
