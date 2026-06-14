# Nexus Project TODO List

## ✅ 2026-06-14: Daemon + MCP Architecture Refactor (DONE)

**Objective**: Replace the flawed Host/Guest election mechanism with a standalone daemon as the single source of truth.

**Root problem solved**: The old election model assumed all AI instances shared the same `localhost` namespace. This breaks across Windows/WSL/VM environments and when the "Host" IDE is closed.

### Completed
- [x] `src/daemon/server.ts` — Full REST API server with all 20 tool definitions + handlers
- [x] `src/client/nexus-client.ts` — Stateless HTTP client (`fetchTools` + `callTool`)
- [x] `src/server/nexus.ts` — Pure MCP proxy: fetches tools from daemon, forwards all calls
- [x] `src/index.ts` — Clean `daemon` / `mcp` entry points
- [x] `src/config/index.ts` — Removed election config, reads `NEXUS_ROOT` env
- [x] Deleted: `src/network/`, `src/auth/`, `src/tools/`, `src/resources/`
- [x] All 17 tests passing
- [x] All documentation updated

---

## Backlog

### Near-term
- [ ] `upload_project_asset` — migrate to async task pattern (consistent with other write ops)
- [ ] Task cleanup job — scheduled purge of expired/completed tasks
- [ ] Daemon process management — systemd / launchd / PM2 integration guide

### Future
- [ ] Authentication layer — API key for daemon access (production deployments)
- [ ] Cross-machine live sync — daemon-to-daemon bridge (beyond baseline scope)
- [ ] IDE sidebar integration — optional SSE endpoint for real-time message display
- [ ] Streaming task progress — periodic progress notifications

---

## Completed History

### ✅ 2026-01-14: Stability & Automation (v0.4.2)
- Lefthook integration (lint on commit, build+test on push)
- E2E test stability fixes

### ✅ 2026-01-08: Global Hub Architecture (v0.3.0)
- Auto Host election, SSE communication, heartbeat/watchdog
- (Superseded by daemon architecture in v0.5.0)

### ✅ 2026-01-01: Token Economy Optimization (v0.2.1)
- Hand-crafted tool definitions (-49% token reduction)
- Incremental read cursor for messages
- Context7-style progressive topology loading

### ✅ 2025-12-31: Task Primitive System (v0.2.0)
- Async task lifecycle (create/get/list/cancel)
- Meeting + Task separation
- Zod type safety

### ✅ 2025-12-30: Meeting Architecture (v0.1.8)
- SQLite WAL backend with JSON fallback
- Meeting lifecycle (start/end/archive/reopen)
- Read cursors per instance
