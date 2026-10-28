# Architecture & Standards

[中文版](ARCHITECTURE_zh.md)

## 🏛️ System Architecture

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus-host (Go)                 │
│  Tray app, or a boot service (`service install`) │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  HTTP API        │  │  Storage             │  │
│  │  GET  /health    │  │  one SQLite file     │  │
│  │  GET  /api/tools │  │  (nexus.db, WAL),    │  │
│  │  POST /api/tools │  │  numbered migrations,│  │
│  │       /call      │  │  one transaction     │  │
│  │  POST /api/hook  │  │  per write           │  │
│  └──────┬───────────┘  └──────────────────────┘  │
│  Tools, conversations, LAN discovery, cleanup    │
└─────────┼────────────────────────────────────────┘
          │ HTTP  (NEXUS_ENDPOINT — cross-env capable)
   ┌──────┼──────┐
   ▼      ▼      ▼
MCP-A  MCP-B  MCP-C      hooks (Claude Code / Codex)
(Win)  (WSL)  (VM)       POST /api/hook per client event
n2n-nexus (npm): stateless adapter, one per MCP connection
```

Two programs share one protocol:

- **`n2n-nexus-host`** (Go, `host/`): owns all data, tool definitions and business logic. Installed from GitHub Releases, Homebrew or Scoop.
- **`n2n-nexus`** (TypeScript, npm, `src/`): the client only — the MCP adapter (`mcp`), the hook command (`hook`), `install` / `uninstall` for Claude Code and Codex, and `doctor`. It contains no storage and no server.
- **`contract/`** is the single source of the protocol between them: `tools.json` (every tool's name, title, description, annotations, input and output JSON Schema), `hook.json` (hook fields, `_meta` keys, timings, limits, notification texts) and `errors.json` (endpoints, error body, status codes). The host embeds these files, the client reads `hook.json` at run time, and the conformance tests in `tests/conformance/` check a host against them. `GET /health` reports the host's `contractVersion`; `n2n-nexus doctor` compares it with the client's.

### Core Principles

1. **The host is the single source of truth** — all reads/writes, business logic, and tool definitions live in the host.
2. **MCP is stateless** — no hardcoded tool names, no local persistent data and no session of its own; conversations and direct messages live in the host.
3. **The host decides tool capability** — the adapter fetches `GET /api/tools` at startup and reconnect.
4. **No local fallback** — if the host is unreachable, the MCP reports an error and retries every 3 s. No split-brain degradation. A tool call the host rejects (validation, not found, permission) is returned to the IDE as an error result (`isError: true`) and does not affect the connection; an unknown tool name is a JSON-RPC `-32602` error.
5. **Plain HTTP between MCP, hooks and host** — the client's hooks report conversation events and carry new-message notifications back to the model; the model reads the text with a tool.

### MCP Startup Flow

```
Read NEXUS_ENDPOINT (default: http://127.0.0.1:5688)
  │
  ├─ Serve stdio (MCP TypeScript SDK v2, serveStdio) and GET /api/tools once;
  │  the first tools/list waits up to 1 s for that fetch
  │     ├─ 2026-07-28 clients: server/discover, per-request _meta envelope,
  │     │  list_changed delivered on subscriptions/listen
  │     └─ 2025-era clients: initialize handshake, unsolicited list_changed
  │
  ├─ Nothing answers: say how to start n2n-nexus-host on this machine,
  │  or on the remote machine for a remote endpoint; never start one
  ├─ A call not answered in time fails alone: tool list kept, no reconnect
  │
  ├─ If the host was down: retry loop (every 3 s)
  │     └─ GET /api/tools succeeds → cache tool list
  │           → notifications/tools/list_changed → IDE re-fetches
  │
  └─ stdin closes → stop retrying, close, exit
```

The adapter's instance ID (the identity of chat and meeting calls from clients without hooks) uses the first client name seen on the connection, from the request's `io.modelcontextprotocol/clientInfo` (2026-07-28) or from `initialize` (2025 era), unless `NEXUS_INSTANCE_ID` / `--id` pins it. Every tool call carries it as `instanceId`. With the hooks installed, chat and meeting calls are identified by the conversation instead (`caller`, resolved through the hook's toolUseId binding or the Codex session id), so conversations sharing an instance keep their own unread cursors.

### Conversations and hooks

Each Claude Code or Codex conversation is one session, `claude:<session id>` or `codex:<session id>`, using the ID the client itself assigns. `n2n-nexus install <claude|codex>` writes hooks that run `n2n-nexus hook <client>` on SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd (and, for Claude Code, PreToolUse on the n2n-nexus tools). The hook command forwards the event's identifying fields to `POST /api/hook` and prints the host's answer; on any error it exits 0 without output, so a missing host never blocks the client.

```
Client event ──▶ n2n-nexus hook ──▶ POST /api/hook ──▶ session status, notifications
                                                        │
UserPromptSubmit / PostToolUse ◀── additionalContext ◀──┤  "2 unread direct messages ..."
Stop                           ◀── decision: block   ◀──┘  once per stop, or on arrival while listening
```

Tool calls name their conversation outside the model's arguments. The adapter reads it from the request's `_meta`: Claude Code sends `claudecode/toolUseId`, which the PreToolUse hook bound to the conversation just before the call (verified: the call waits for the hook); Codex sends `sessionId`. The adapter forwards it as `caller` in `POST /api/tools/call`. Because the identity is the conversation, not the adapter process, an adapter restart, a resumed conversation and a sub-agent all keep it, and one adapter can serve several Codex conversations.

Notifications carry each message whole (the texts of one notification together cut at `notifyTextChars`, 5000 characters; `read` returns a cut message), so the request reaches the model in the hook's injected context or Stop reason, where Claude Code weighs it as hook feedback, rather than only as tool output. They say that the sessions belong to the same user, so a request is that user's instruction, already approved: it is carried out without asking the user for confirmation, and a question about it goes to the sender. Claude Code still acts on another session's message only where the user's own instructions call for it, so `install claude` adds a marked block with that instruction to the user-level `CLAUDE.md`. A message shown whole is marked read when it needs no reply or the announcement drives the turn (Stop, listening, background wake; a failed wake makes it unread again); one that asks for a reply, announced with a prompt or after a tool call, stays unread until `reply` answers it or `read` returns it, so Stop still holds the turn once for one left unanswered. A listening Stop hook is held open for up to 590 s and answered as soon as a message arrives; the client killing the hook (the user pressing Esc) or the host shutting down ends the wait. This remains a trusted local host, not an authentication boundary: every process of the same operating-system user is trusted and could act as any conversation, and agents that must be isolated run as different users with their own hosts (see the local trust model in [SECURITY.md](../SECURITY.md)). See [tool reference](TOOLS_REFERENCE.md#direct-messages-between-conversations).

### Sessions, presence and waking idle conversations

A new conversation's SessionStart hook prints an introduction: its own name and ID, the other sessions that are not offline (up to five), how to use `peers`, `send` and `read`, and the collaboration rules (a message is the user's instruction, carried out without asking the user for confirmation, with questions going to the sender; hand work on in one message with everything the recipient needs; answer once with the result, or with what stopped the work and the one thing that would let it go on; no plain acknowledgements; no task passed back to its sender). The adapter also sends MCP server instructions with the same guidance. Clients do not always report the end of a conversation, so an `idle` or `working` session without activity for 30 minutes counts as `offline` until its next event.

An idle conversation is not running, so hooks alone can only reach it when its user acts. To let AI sessions carry out each other's requests and answer without anyone typing, `install` adds a second Stop hook, `n2n-nexus hook <client> --wait`, that starts a background wait when a turn ends:

```
turn ends ──▶ Stop hook (announces unread, or listens)
          └─▶ Stop hook --wait ──▶ POST /api/hook {BackgroundWait}  (up to 590 s per request, repeated for up to 1 h)
                                     │  session shows as "listening"
                                     ├─ new message ─▶ { wake: notification, dispatchId }
                                     │     Claude Code: asyncRewake hook exits 2, the notification starts a turn
                                     │     Codex: detached process runs `codex queue --thread <id> --message <notification>`,
                                     │       then reports POST /api/hook {WakeResult, dispatch_id, ok}
                                     ├─ any other event of the session ─▶ null (wait ends)
                                     └─ time runs out or host shuts down ─▶ { timeout: true } (ask again)
```

The background wait retries temporary connection failures within its original one-hour deadline; with `discover`, it looks up the host again. A normal cancellation (`output: null`) still ends the wait. Host and client must both include this recovery behavior for graceful host restarts to resume waiting.

The wait never delivers while the session is `working` or while a listening Stop hook is waiting, so a message is announced once. When `codex queue` fails (an error or a non-zero exit), the Codex wait reports `ok: false` and the host undoes that wake: the messages and notices it announced count as not announced again, the session leaves `working` and the automatic turn is not counted; the wait then asks again after 1 s, doubling after each failure up to 5 minutes, and delivers them again. Any other event of the session before the report means the wake was delivered, and the report is ignored. Verified on Windows with the Claude desktop app and the Codex desktop app (2026-10-23): both directions wake an idle conversation within seconds. Known limits:

- Codex starts a queued turn only for a conversation loaded in the running Codex app. After Codex restarts, a conversation is loaded once the user opens it.
- The Codex background wait ends when the Codex app quits, and starts again only when the conversation ends a turn. Messages sent meanwhile stay unread in the host (not in Codex's own queue) until the user next prompts that conversation.
- A Claude Code conversation is reachable for an hour after its last turn (the hook timeout).
- Every AI reply wakes the recipient again, so sessions can work through each other's requests without anyone typing. To cap that, set `maxAutoTurns` in `settings.json` (default 0, no limit): the host then counts automatic turns (wakes, listening Stops, Stops held open for messages) since the user's last prompt and stops after that many; a prompt within a minute of a wake is the woken turn starting and keeps the count. Messages past the limit wait until the user prompts. Meeting news is not counted and is not limited: a meeting runs until it is ended, and a message with `wake: false` never wakes anyone.
- The automatic turn count tells the woken turn from the user by time alone. If a wake does not start a turn (a Codex conversation not loaded) and the user prompts within that minute, that prompt keeps the count; the user's next prompt resets it. If a woken turn starts more than a minute late (a Codex conversation the user opens later), its prompt resets the count. Neither loses a message or lets sessions loop without a user.

---

## 💾 Data Persistence

All data lives in one SQLite file, `nexus.db`, in the host's data directory, next to `settings.json` and `host.lock` (locations per OS: [User guide](USER_GUIDE.md#data-and-logs)).

- **Schema**: numbered migrations embedded in the host (`host/internal/store/migrations/0001_core.sql`, `0002_agents.sql`) run in order at startup, each in one transaction; the version is `PRAGMA user_version`. A database newer than the host is refused ("upgrade n2n-nexus-host").
- **Tables**: `projects` (scalar manifest fields as columns, structured fields as JSON, internal docs as text), `project_relations` and `project_assets` (asset bytes as BLOBs; both cascade on project rename and delete), `global_strategy`, `global_docs`, `meetings` (with `status` and `is_default`), `meeting_messages` (numbered per meeting with `seq`), `meeting_members` (who takes part, how, and what they were told), `decisions`, `global_messages`, `events`, `tasks`, `read_cursors`, and for conversations `agent_sessions`, `agent_messages`, `agent_notices`, `agent_idle_subscriptions`, `tool_use_bindings` and `hooked_instances` (adapter instances whose calls resolved a conversation, for chat and meeting identity).
- **Transactions**: every write is one transaction, so a multi-row change (a meeting message, starting / ending / reopening a meeting, renaming a project) is applied completely or not at all. The database runs in WAL mode with `foreign_keys` on and a 5 s busy timeout, through a single connection.
- **Only the host opens the database**. MCP adapters and hooks go through HTTP.
- **Activity log**: state changes made through tools (project sync/update/rename/delete/asset, doc sync, strategy update, meeting start/end/archive/reopen, maintenance) are recorded as structured events and read with `list_events`; they are not mixed into chat streams.

Meeting members and stances store their resolved identity kind; draft eligibility is captured in the publishing transaction. Migration `0009` backfills legacy identities by exact matches with registered sessions and corrects active drafts' instance approvers without changing settled meeting lists. For a legacy optional member whose join and draft share a millisecond, the old data cannot establish their order: existing required approvers keep eligibility, but an unlisted member cannot opt into that draft and becomes eligible when a new draft is published.

### Maintenance and retention

At startup and then every hour the host:

- marks pending or running tasks past their TTL as `failed` and deletes tasks 7 days after they finished (`completed`, `failed`, `cancelled`);
- deletes events older than 30 days;
- expires unread direct messages past their 24-hour lifetime (telling the senders), and deletes read or expired direct messages and delivered notices after 30 days;
- deletes tool-use bindings once they have expired (5 minutes).

Logs (files and locations: [User guide](USER_GUIDE.md#data-and-logs)): only the holder of `host.lock` writes `host.log`; the tray's own lines go to `tray.log`.

---

## 🌐 Deployment Model

The commands of both programs are listed in the [User guide](USER_GUIDE.md#6-reference).

**Host**: started as a tray app or a boot service; the adapter and the hooks never start one, they report that none answers. Configuration comes only from `<data dir>/settings.json` (`host`, `port`, `discoveryPort`, `allowedHosts`, `rateLimit`, `rateBurst`, `maxAutoTurns`, `stanceReminderMinutes`), overridden by command-line flags; the only environment variable the host reads is `NEXUS_ROOT`. A service does not get the environment of the terminal that installed it, so the file is the one source the tray, the service and the command line share.

**Standalone host on a LAN**: one host with LAN access on serves every machine, independent of any IDE; each client machine needs only the client, which finds the host by UDP broadcast (`--endpoint discover`). Setup: [Installation guide](INSTALL.md#6-several-machines-and-environments).

**No required startup order**: start the IDE before the host — tools appear automatically once the host comes up. Host restarts are transparent; MCP reconnects and notifies the IDE.

### Tray and service per OS

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Boot service (`service install`, administrator / root) | Scheduled task `n2n-nexus-host`: at startup, S4U logon of the installing user (no password stored), no time limit | `/Library/LaunchDaemons/io.n2ns.n2n-nexus-host.plist` with `UserName`, `RunAtLoad`, `KeepAlive` | `/etc/systemd/system/n2n-nexus-host.service` with `User=`, `Restart=always`, `RestartSec=5` |
| Tray at login (`autostart`, tray menu) | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `n2n-nexus-host` | `~/Library/LaunchAgents/io.n2ns.n2n-nexus-host.tray.plist` | `~/.config/autostart/n2n-nexus-host.desktop` |
| LAN access from the tray | Adds inbound TCP / UDP firewall rules through a UAC prompt (`netsh advfirewall`) | Tells the user which ports to allow | Tells the user which ports to allow |

Every service runs `n2n-nexus-host serve --supervise --root <data dir> --log-dir <log dir>` with the installing user's directories, so the service's own environment does not move them: the supervisor runs `serve` as a child process and starts it again 5 s after it exits, and logs to `host.log`. `service install` refuses while a tray runs the host for the data directory in-process (quit the tray first; opened again, it controls the service); otherwise it stops the host running for the data directory (found through the PIDs recorded in `host.lock`, never by matching command lines), writes `--host` / `--port` to `settings.json`, registers and starts the service and reports what answers on the port; under `sudo` it uses the invoking user's default directories. `service uninstall` removes the service and stops only the service's own `serve`, never a tray or a foreground `serve`. The tray first probes `GET /health` on the configured port: when a host answers (for example the service), it only controls that host — **Restart** (and a changed setting) writes `restart-request` into the data directory; the service's `serve` polls for it every second and exits, and its supervisor starts it with the new settings (a file, since the tray may not end a process of the scheduled task's S4U logon), then waits up to 20 s for it to answer again, never starting a host of its own — and otherwise it runs the host in-process. Changing a setting from the tray writes `settings.json` and restarts the host. The menu shows the address the host is bound to and the number of online sessions (`sessions.online` of `GET /health`), refreshed every 5 s. An IPv4 address (`0.0.0.0` included) listens on IPv4 only, an IPv6 address on IPv6 only. The tray's texts are Chinese on a Chinese system and English otherwise (on macOS without `LANG`, as under the login item, from `AppleLanguages`). The macOS tray needs cgo (Cocoa), so macOS release builds are built on macOS with `CGO_ENABLED=1`; Windows and Linux are cross-compiled with `CGO_ENABLED=0`, and Windows ships two builds of the same program: `n2n-nexus-host.exe` (console, for commands; run without arguments it starts the tray build next to it and returns) and `n2n-nexus-host-tray.exe` (GUI, `-H=windowsgui`, opens no console window; start at login registers it).

### Single instance

A host takes an exclusive lock on `<data dir>/host.lock` before it opens the database and records its PID, its supervisor's and its role (`tray`, `serve` or `supervised`) there. A second host for the same data directory exits with "another n2n-nexus-host is running for <dir> (PID n)".

---

## 🧩 Host internals

```
host/
├── cmd/n2n-nexus-host/   command line: tray (default), serve, service, autostart, version
└── internal/
    ├── config/           data and log directories, settings.json
    ├── protocol/         loads the embedded contract (contract/contract.go), compiles the JSON Schemas,
    │                     strips undeclared argument keys, validates arguments and results
    ├── store/            opens nexus.db, runs the migrations, transactions
    ├── core/             project, doc, meeting, chat, event and task tools and their tables
    ├── agents/           conversations: hooks, direct-message tools, waits, their tables
    ├── api/              HTTP server: the 4 endpoints, Host / Origin guard, body limit, rate limits
    ├── discovery/        UDP LAN discovery responder
    ├── host/             assembles one host: lock, database, tools, server, discovery, hourly maintenance, logs
    ├── tray/             tray menu and its English / Chinese texts
    ├── service/          boot service, tray autostart, the `serve --supervise` supervisor, firewall script
    ├── clock/            system clock and the settable test clock
    └── testhooks/        test-build only (`-tags testclock`): POST /test/clock, --test-listen-wait-ms
```

The Go module is `github.com/n2ns/n2n-nexus` at the repository root, so the host embeds `contract/` directly. A tool exists only if it is in `contract/tools.json`; the host registers one handler per tool and logs any tool without a handler at startup.

**Conversation state machine**: `agents.Agents` is the in-process coordinator of one host. It holds all in-memory conversation state — held listening Stops, background waits, automatic-turn counts, wake times — behind one mutex; every hook and direct-message tool call runs under it, and whoever stores a message or notice delivers it to a waiting hook before releasing the lock. At startup it resets sessions a previous host left `listening` to `idle`. Shutting down answers held background waits with `{ "output": { "timeout": true } }` so they reconnect, and held listening Stops with `{ "output": null }`, before the server closes. Time comes from a `Clock`: the system clock in release builds, a clock the conformance tests set through `POST /test/clock` in the `testclock` build.

**Discovery**: a host whose `host` is not a loopback address answers `n2n-nexus/discover` datagrams on UDP `discoveryPort` with `{"service":"n2n-nexus","version","host","port"}`. Clients with `NEXUS_ENDPOINT=discover` broadcast the query on `NEXUS_DISCOVERY_PORT`, use the first answer and cache it in `~/.n2n-nexus/discovered-endpoint`.

---

## 📡 HTTP API

The host has four endpoints (see `contract/errors.json`):

```
GET  /health                 { ok, service: "n2n-nexus", version, contractVersion, sessions: { online } }
GET  /api/tools              Tool definitions from contract/tools.json (JSON Schema)
POST /api/tools/call         { tool, args, instanceId, caller? } → { ok: true, result }
POST /api/hook               Client hook event { client, input } → { output }; the BackgroundWait event is the background wait
```

Every capability is a tool; there are no other REST routes (an unknown route is 404). A tool call validates `args` against the tool's input schema after dropping keys the schema does not declare (400 `Invalid arguments for <tool>: ...`), and the result against its output schema. A failure the caller caused, including "not found", is 400 with the error text; an unknown tool is 404. Errors have the body `{ ok: false, error }`.

### Request guards

The host has no authentication, so it keeps web pages out: it rejects browser-originated requests (`Origin` header or cross-site `Sec-Fetch-Site`: 403), `Host` names that are neither IP literals nor `localhost`, `host.docker.internal` or a name in `allowedHosts` (403, prevents DNS rebinding), POST bodies that are not `application/json` (415) and bodies above 16 MB (413).

Rate limits are token buckets (`rateLimit` per second, `rateBurst` at once; `rateLimit: 0` disables them), answered with 429 and `Retry-After`:

- tool calls per conversation (the session the hooks identify from the caller's Claude `toolUseId` or Codex `sessionId`), else per `instanceId`, and, because these IDs are self-declared, per client address at 5x;
- hooks per conversation (`<client>:<session_id>`) and per client address at 5x, in buckets of their own, so a busy conversation's hooks do not use up the tool-call budget of its address;
- `GET /health` and `GET /api/tools` are not limited.

The trust model is unchanged: every process of the same operating-system user is trusted. See `SECURITY.md`.

## Scope Boundaries

- No cloud bridge by default.
- No cross-machine live sync by default — point `NEXUS_ENDPOINT` at a reachable host for that, or set it to `discover` to find a host with LAN access on through a UDP broadcast.
- Single host node; no built-in clustering.
- No authentication layer in the open-source baseline.
