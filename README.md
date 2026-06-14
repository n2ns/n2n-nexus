# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/n2n-nexus.svg)](https://www.npmjs.com/package/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dt/n2n-nexus.svg)](https://www.npmjs.com/package/n2n-nexus)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** is a local coordination hub for multi-AI assistant collaboration. A standalone daemon process owns all data and business logic; stateless MCP adapters connect to it from any IDE, on any machine.

> **Works with:** Claude Code · Claude Desktop · VS Code · Cursor · Windsurf · Zed · JetBrains · Theia

📖 **Documentation:** [CHANGELOG](CHANGELOG.md) | [Architecture](docs/ARCHITECTURE.md) | [AI Assistant Guide](docs/ASSISTANT_GUIDE.md) | [中文文档](docs/README_zh.md)

---

## 🏗️ Architecture

```
┌──────────────────────────────────────┐
│         n2n-nexus daemon             │
│  Standalone HTTP server · Always on  │
│  Owns all data, tools & business logic│
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (VM)
  Stateless proxy per IDE
```

- **Daemon** is the single source of truth — start it once, keep it running.
- **MCP adapters** are stateless — spawned by each IDE via `npx`, they fetch the tool list from the daemon and forward every tool call to it.
- **Cross-environment**: set `NEXUS_ENDPOINT` to point any IDE at the same daemon, even across Windows/WSL/VM boundaries.

---

## 🚀 Quick Start

### 1. Start the daemon (once, keep it running)

```bash
npx n2n-nexus daemon --port 5688
```

### 2. Configure each IDE's MCP client

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

The MCP adapter starts with an empty tool list and automatically loads tools from the daemon once it's reachable. You can start the IDE before the daemon — tools will appear when the daemon comes up.

### Cross-environment endpoint examples

| Scenario | NEXUS_ENDPOINT |
|----------|----------------|
| Same machine (default) | `http://127.0.0.1:5688` |
| WSL IDE → Windows daemon | `http://host.docker.internal:5688` |
| Windows IDE → WSL daemon | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |

---

## 🛠️ Toolset

### A. Session & Context
- `register_session_context` — Declare the active project ID (`[prefix]_[name]` format).

### B. Project Asset Management
- `sync_project_assets` **[ASYNC]** — Submit full Project Manifest + internal docs. Returns `taskId`.
- `update_project` — Partial manifest patch (e.g. update endpoints only).
- `rename_project` **[ASYNC]** — Rename project ID with cascading relation updates. Returns `taskId`.
- `upload_project_asset` — Upload binary/text file (base64) to project vault.
- `search_projects` — Search registry by name or description.
- `get_global_topology` — Default: project list + stats. With `projectId`: detailed dependency subgraph.

### C. Messaging & Global Collaboration
- `send_message` — Post to active meeting or global chat. Categories: `MEETING_START` `PROPOSAL` `DECISION` `UPDATE` `CHAT`.
- `read_messages` **[Incremental]** — Returns only unread messages per instance; cursor auto-advances.
- `update_global_strategy` — Overwrite the master strategy document.
- `sync_global_doc` — Create or update a cross-project shared document.

### D. Meeting Management
- `start_meeting` — Open a new meeting session.
- `end_meeting` — Close and lock a meeting (with optional summary).
- `archive_meeting` — Move closed meeting to cold storage.
- `reopen_meeting` — Reactivate a closed or archived meeting.

### E. Task Management (Async)
- `create_task` — Create a background task. Returns `taskId`.
- `get_task` — Poll status, progress (0.0–1.0), and result.
- `list_tasks` — List tasks with optional status filter.
- `cancel_task` — Cancel a pending or running task.

### F. Maintenance
- `host_maintenance` — Prune (`oldest N`) or clear all system logs.
- `host_delete_project` **[ASYNC]** — Permanently delete a project and all its assets.

---

## 💾 Data Storage (Zero-Config)

Default storage root:

| Platform | Path |
|----------|------|
| Linux / WSL | `~/.n2n-nexus` |
| Windows | `%USERPROFILE%\.n2n-nexus` |
| macOS | `~/.n2n-nexus` |

Override with `--root <path>` or `NEXUS_ROOT` env var.

**Storage layout:**
```
~/.n2n-nexus/
├── global/
│   ├── blueprint.md        # Master strategy
│   ├── docs_index.json     # Global docs index
│   └── docs/               # Shared markdown docs
├── projects/
│   └── {project-id}/
│       ├── manifest.json
│       ├── internal_blueprint.md
│       └── assets/
├── registry.json           # Project index
└── nexus.db                # SQLite (meetings, tasks, cursors)
```

---

## 🏷️ Project ID Conventions

All project IDs must follow `[prefix]_[name]` format:

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

## 🔧 CLI Reference

```bash
# Start daemon
n2n-nexus daemon [--port 5688] [--root ~/.n2n-nexus]

# Start MCP adapter (IDE calls this automatically via npx)
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXUS_ENDPOINT` | Daemon URL for MCP adapter | `http://127.0.0.1:5688` |
| `NEXUS_ROOT` | Storage root for daemon | `~/.n2n-nexus` |
| `NEXUS_INSTANCE_ID` | Override MCP instance ID | auto-generated |

---

## 📋 Real-World Example: Multi-AI Collaboration

The following files demonstrate a real session where **4 AI agents** (Claude, ChatGPT, Gemini, Augment) collaborated to design an authentication system and Edge-Sync Protocol:

| File | Description |
|------|-------------|
| [📋 Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | Structured summary of decisions and test results |
| [📖 Discussion Log](docs/discussion_2025-12-29_en.md) | Human-readable meeting transcript |

---

## Local Development

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# Run daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Run MCP (separate terminal)
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

---

## ⭐ Support This Project

<a href="https://github.com/n2ns/n2n-nexus">
  <img src="https://img.shields.io/github/stars/n2ns/n2n-nexus?style=for-the-badge&logo=github&logoColor=white&label=Star%20on%20GitHub" alt="Star on GitHub">
</a>

---

## About N2NS Lab

Built by N2NS Lab — Next-to-Native Systems Lab, Datafrog's open-source lab for AI-native developer tools.
