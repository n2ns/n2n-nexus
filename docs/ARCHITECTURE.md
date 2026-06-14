# Architecture & Standards

## 🏛️ System Architecture

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  Standalone HTTP server · User starts manually   │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  REST API    │  │  Storage Layer           │  │
│  │  /api/tools  │  │  SQLite (WAL) + JSON FS  │  │
│  │  /api/tools  │  │                          │  │
│  │    /call     │  │  Single writer — no lock │  │
│  └──────┬───────┘  └──────────────────────────┘  │
│  All business logic, tool definitions, data I/O  │
└─────────┼────────────────────────────────────────┘
          │ HTTP  (NEXUS_ENDPOINT — cross-env capable)
   ┌──────┼──────┐
   ▼      ▼      ▼
MCP-A  MCP-B  MCP-C
(Win)  (WSL)  (VM)
Stateless protocol adapter, one per IDE
```

### Core Principles

1. **Daemon is the single source of truth** — all reads/writes, business logic, and tool definitions live in the daemon.
2. **MCP is a stateless protocol adapter** — no tool definitions, no hardcoded names, no local data.
3. **Daemon decides tool capability** — MCP fetches `GET /api/tools` at startup; any daemon upgrade is immediately visible to all connected MCPs.
4. **No local fallback** — if the daemon is unreachable, the MCP reports an error and retries every 3 s. No split-brain degradation.
5. **Plain HTTP between MCP and daemon** — no SSE; AI is request-driven and doesn't need push.

### MCP Startup Flow

```
Read NEXUS_ENDPOINT (default: http://127.0.0.1:5688)
  │
  ├─ Connect stdio transport → IDE sees MCP as ready
  │
  └─ Background retry loop (every 3 s)
        │
        ├─ GET /api/tools fails
        │     → log "[n2n-nexus] Waiting for daemon..."
        │     → keep retrying, do not exit
        │
        └─ GET /api/tools succeeds
              → cache tool list
              → send notifications/tools/list_changed
              → IDE re-fetches: tools appear
```

---

## 💾 Data Persistence

All data lives under the daemon's storage root (default `~/.n2n-nexus`):

```
~/.n2n-nexus/
├── global/
│   ├── blueprint.md        # Master strategy document
│   ├── discussion.json     # Global chat (JSON fallback)
│   ├── docs_index.json     # Global docs index
│   └── docs/               # Shared markdown documents
├── projects/
│   └── {project-id}/
│       ├── manifest.json          # Project metadata
│       ├── internal_blueprint.md  # Internal technical docs
│       └── assets/                # Binary assets (images, PDFs)
├── meetings/               # Meeting files (JSON fallback mode)
├── registry.json           # Global project index
└── nexus.db                # SQLite database (meetings, tasks, cursors)
```

**SQLite WAL mode**: Only the daemon process writes to SQLite directly. MCP processes never touch the DB — they go through HTTP, which serializes all writes naturally.

**Self-healing**: Core JSON files (`registry.json`, `discussion.json`) are auto-repaired if corrupted or missing.

---

## 🏷️ Project ID Conventions

All project IDs must follow the `[prefix]_[name]` format:

| Prefix | Category | Example |
|--------|----------|---------|
| `web_` | Websites | `web_datafrog.io` |
| `api_` | Backend services | `api_user-auth` |
| `mcp_` | MCP servers | `mcp_nexus` |
| `lib_` | Libraries / SDKs | `lib_crypto-core` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VSCode extensions | `vscode_super-theme` |
| `android_` | Android apps | `android_client-app` |
| `ios_` | iOS apps | `ios_client-app` |
| `flutter_` | Flutter apps | `flutter_unified-app` |
| `desktop_` | Desktop apps | `desktop_main-hub` |
| `bot_` | Bots | `bot_auto-moderator` |
| `infra_` | Infrastructure / DevOps | `infra_k8s-config` |
| `doc_` | Documentation | `doc_coding-guide` |

---

## 🌐 Deployment Model

One npm package, two commands:

```
n2n-nexus
  │
  ├─ n2n-nexus daemon    Start once, keep running. Owns all data.
  │
  └─ n2n-nexus mcp       IDE starts automatically via npx. Stateless proxy.
```

**Daemon** (user starts manually):
```bash
npx n2n-nexus daemon --port 5688
# or with explicit root
npx n2n-nexus daemon --root ~/.n2n-nexus --port 5688
```

**MCP** (IDE configuration):
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": { "NEXUS_ENDPOINT": "http://127.0.0.1:5688" }
    }
  }
}
```

**No required startup order**: start the IDE before the daemon — tools appear automatically once the daemon comes up. Daemon restarts are transparent; MCP reconnects and notifies the IDE.

---

## 📡 REST API

### Tool capability (MCP-facing)
```
GET  /api/tools              Return full tool definition list (JSON Schema)
POST /api/tools/call         Execute tool call { tool, args, instanceId }
```

### System
```
GET  /health                 Health status + version
GET  /api/storage/info       Storage mode and stats
```

### Session & Projects
```
POST /api/session/register
POST /api/projects/sync
POST /api/projects/update
POST /api/projects/rename
POST /api/projects/delete
GET  /api/projects/search
GET  /api/projects/topology
```

### Messages & Global
```
POST /api/messages/send
GET  /api/messages/unread
GET  /api/global/docs
GET  /api/global/docs/:docId
POST /api/global/docs/:docId
POST /api/global/strategy
```

### Meetings
```
POST /api/meetings/start
POST /api/meetings/end
POST /api/meetings/archive
POST /api/meetings/reopen
GET  /api/meetings/:meetingId
```

### Tasks
```
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/update
POST /api/tasks/:taskId/cancel
```

### Maintenance
```
POST /api/maintenance/logs
```

---

## Scope Boundaries

- No cloud bridge by default.
- No cross-machine live sync by default — point `NEXUS_ENDPOINT` at a reachable host for that.
- Single daemon node; no built-in clustering.
- No authentication layer in the open-source baseline.
