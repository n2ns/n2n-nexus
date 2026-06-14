# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc → build/
npm run dev            # tsc -w (watch mode)
npm test               # vitest run (all tests)
npm run lint           # eslint src/**

# Run a single test file
npx vitest run tests/daemon_messages.test.ts

# Run daemon locally
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Run MCP server locally
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

Pre-commit runs lint; pre-push runs `build && test` (via lefthook).

## Architecture

The daemon + MCP refactor is complete (v0.5.0). See `REFACTOR_PLAN.md` for the full rationale.

### Entry point
`src/index.ts` routes to `runDaemon()` (`src/daemon/`) or `NexusServer().run()` (`src/server/nexus.ts`) based on the first CLI argument (`daemon` or default).

### Daemon (`src/daemon/`)
`server.ts` — plain `http.Server` with all REST endpoints. Contains `TOOL_DEFINITIONS` (20 tools with JSON Schema), per-instance session map (`Map<instanceId, {currentProject}>`), and individual tool handler functions. Routes: `GET /api/tools`, `POST /api/tools/call`, plus project/message/meeting/task/maintenance endpoints.

### MCP Server (`src/server/nexus.ts`)
Pure stateless proxy. On startup: connects stdio transport, then tries `GET /api/tools`; if daemon unreachable, schedules 3-second retry loop. On connect: calls `server.sendToolListChanged()`. `CallTool` → `POST /api/tools/call`. No hardcoded tool names.

### Storage layer (`src/storage/`) — unchanged
- `StorageManager` (`index.ts`) is the single access point; delegates to sub-modules
- `sqlite.ts` + `sqlite-meeting.ts` — SQLite with WAL mode for meetings, tasks, read cursors
- `store.ts` (`UnifiedMeetingStore`) — auto-selects SQLite or JSON fallback for meetings
- `registry.ts` / `projects.ts` / `logs.ts` / `docs.ts` — JSON file-based storage for projects, global docs, logs
- `paths.ts` — all file paths derived from `getRootPath()` which reads `NEXUS_ROOT` env or `~/.n2n-nexus`

Only the daemon process accesses SQLite directly. MCP processes go through HTTP.

### Key SDK patterns
```typescript
// Capability must declare listChanged for notifications to work
capabilities: { tools: { listChanged: true } }

// On daemon connect:
server.sendToolListChanged(); // triggers IDE to re-fetch
```

## TypeScript / Module Notes

- Project uses `"module": "NodeNext"` — all internal imports **must** use `.js` extension even for `.ts` source files
- Tests use `port: 0` for dynamic port allocation and write to `tests/tmp/` (cleaned per test)
- Test files run sequentially (`fileParallelism: false`) to avoid SQLite file conflicts
