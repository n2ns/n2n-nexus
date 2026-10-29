# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build            # tsc → build/
npm run dev              # tsc -w (watch mode)
npm run lint             # eslint src tests
npm test                 # vitest run: client tests (globalSetup builds the client and the Go test host first)
npm run host:build-test  # go build -tags testclock → host/bin/test/n2n-nexus-host
npm run test:conformance # black-box tests in tests/conformance/ against NEXUS_HOST_BIN (default: the test build)
npm run check            # lint, test, build, audit, pack dry run (prepublishOnly)

go vet ./...
go test ./host/...

# Run a single client test file
npx vitest run tests/mcp_proxy.test.ts

# Run the host locally (foreground, no tray)
go run ./host/cmd/n2n-nexus-host serve --port 5799 --root /tmp/x

# Run the MCP adapter against it
NEXUS_ENDPOINT=http://127.0.0.1:5799 node build/index.js mcp
```

Hooks (lefthook): pre-commit runs `npm run lint`; pre-push runs `go vet ./... && go test ./host/... && npm run build && npm test && npm run host:build-test && npm run test:conformance`.

CI (`.github/workflows/host.yml`) runs `go vet`, `go test ./host/...`, lint, build, `npm test`, the test-host build and the conformance tests on ubuntu, windows and macos for every push to main and every pull request. Releases: `v*` tags publish the npm client (`publish.yml`); `host-v*` tags build and release the host (`host-release.yml`, see `host/README.md`).

## Architecture

Two programs share one protocol. See `docs/ARCHITECTURE.md` for the full design.

### Contract (`contract/`)
The single source of the protocol: `tools.json` (every tool's name, title, description, annotations, input and output JSON Schema), `hook.json` (hook clients, request fields, `_meta` keys, the LAN discovery query, timings, limits, notification texts), `errors.json` (endpoints, error body, status codes). The Go host embeds them (`contract/contract.go`), the TypeScript client reads `hook.json` at run time (`src/contract.ts`), and the conformance tests read all three. Bump `contractVersion` in all three files when a change breaks an older client or host. See `contract/README.md`.

### Host (`host/`, Go module `github.com/n2ns/n2n-nexus` at the repository root)
`n2n-nexus-host`: tray by default, `serve` in the foreground, `service install|uninstall|status`, `autostart on|off`, `install` (Windows: install or upgrade from a release folder), `version` (`host/cmd/n2n-nexus-host/main.go`).

- `internal/config` — data and log directories per OS, `settings.json` (`host`, `port`, `discoveryPort`, `allowedHosts`, `rateLimit`, `rateBurst`, `maxAutoTurns`, `stanceReminderMinutes`, `meetingRetentionDays`, `retentionDays`). The only environment variable the host reads is `NEXUS_ROOT`.
- `internal/protocol` — loads the embedded contract, compiles the schemas, strips undeclared argument keys, validates arguments and results.
- `internal/store` — opens `<data dir>/nexus.db` (WAL, foreign keys, one connection), runs `migrations/NNNN_*.sql` in order (version in `PRAGMA user_version`), `Tx` for one transaction per write.
- `internal/core` — project, doc, meeting, chat, event and task tools and their tables (`0001_core.sql`), the hourly cleanup (`cleanup.go`, which also runs the agents' through `api.Cleaner`).
- `internal/cursors` — read cursors and meeting notification watermarks (`read_cursors`, `meeting_members.notified_id`), shared by core and agents.
- `internal/agents` — conversations: the hook handler, the direct-message tools, their tables (`0002_agents.sql`). `agents.Agents` is the in-process coordinator holding all wait state behind one mutex.
- `internal/api` — HTTP server: `GET /health`, `GET /api/tools`, `POST /api/tools/call`, `POST /api/hook`; Host / Origin guard, 16 MB body limit, rate limits per conversation (per instance when none is identified), per address and per hook session.
- `internal/discovery` — UDP LAN discovery responder. `internal/host` — assembles one host (single-instance `host.lock`, database, tools, server, discovery, hourly cleanup, `host.log` / `tray.log` rotation). `internal/tray` — tray menu and texts. `internal/service` — boot service and autostart files per OS, `serve --supervise`, Windows firewall script. `internal/clock`, `internal/testhooks` — the settable clock and `POST /test/clock` / `--test-listen-wait-ms`, compiled only with `-tags testclock`.

### Client (`src/`, npm package `n2n-nexus`)
`src/index.ts` routes to `NexusServer().run()` (`src/server/nexus.ts`, default `mcp`) or the `hook` / `install` / `uninstall` / `doctor` commands (`src/cli/`). The hook path is imported dynamically and must stay free of the MCP SDK: it runs on every client tool call. The client has no storage and never starts a host; when none answers, tool calls fail with `noDaemonHint(endpoint)` (`src/contract.ts`) and the hooks skip silently.

`src/server/nexus.ts` is a stateless proxy on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`): it serves stdio through `serveStdio(() => buildServer())`, fetches `GET /api/tools` in the background (the first `tools/list` waits up to 1 s), retries every 3 s while the host is unreachable and calls `sendToolListChanged()` on connect. `tools/call` → `POST /api/tools/call` with the instance ID (`src/server/instance-id.ts`) and a `caller` read from the request `_meta` (Claude Code `claudecode/toolUseId`, Codex `sessionId`), never from model-supplied arguments. A call the host does not answer within the request timeout fails alone. `src/client/nexus-client.ts` is the HTTP client, `src/client/discovery.ts` the `discover` query side.

`n2n-nexus hook <client>` forwards the hook stdin's `HOOK_INPUT_FIELDS` to `POST /api/hook` and prints `output`; on any error it exits 0 silently. See docs/TOOLS_REFERENCE.md#direct-messages-between-conversations.

### Adding a tool
1. Add it to `contract/tools.json`: name, title, description, annotations, `inputSchema`, `outputSchema`, `publishOutputSchema`.
2. Write the handler in `host/internal/core` (or `host/internal/agents` for conversation tools) and register it in that package's `Register`; the result must satisfy the output schema, which the host checks on every call.
3. Cover it in `tests/conformance/` (`structured_output.test.ts` calls every tool and validates its result) and in the Go tests of the package.
4. Document it in `docs/TOOLS_REFERENCE.md`, and in `docs/ASSISTANT_GUIDE.md` and `docs/ASSISTANT_GUIDE_zh.md` whenever how an assistant uses the tools changes (keep the two guides in sync).

Changing a hook or error text the model reads: edit the text in `contract/hook.json`, then check the expectations in the `host/internal/agents` tests and in `tests/conformance/agents.ts`.

### Key SDK patterns
```typescript
// Capability must declare listChanged for notifications to work
capabilities: { tools: { listChanged: true } }

// On host connect (routed to subscriptions/listen on 2026-07-28 connections):
server.sendToolListChanged();

// 2026-07-28 has no initialize: read client identity per request
ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY] ?? server.getClientVersion()
```

Tests in `tests/mcp_proxy.test.ts` run every proxy case against both a 2025-era client and a client pinned to 2026-07-28 (`@modelcontextprotocol/client`).

## TypeScript / Module Notes

- Project uses `"module": "NodeNext"` — all internal imports **must** use `.js` extension even for `.ts` source files
- Test files run sequentially (`fileParallelism: false`); client tests that need a real host start the Go test build through `tests/conformance/harness.ts` (one host per file, fresh `--root`, `--port 0`, port read from the ready line on stderr)
