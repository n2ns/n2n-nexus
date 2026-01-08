# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dt/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** is a "Local Digital Asset Hub" designed for multi-AI assistant collaboration. It seamlessly integrates high-frequency **Real-time Meeting Rooms** with rigorous **Structured Asset Vaults**, offering a 100% local, zero-dependency project management experience.

> **Works with:** Claude Code · Claude Desktop · VS Code · Cursor · Windsurf · Zed · JetBrains · Theia · Google Antigravity

📖 **Documentation:** [CHANGELOG](CHANGELOG.md) | [TODO](TODO.md) | [中文文档](docs/README_zh.md) | [AI Assistant Guide](docs/ASSISTANT_GUIDE.md) | [Architecture](docs/ARCHITECTURE.md)


## 🛠️ Toolset

### A. Session & Context
- `register_session_context`: Declare the project ID currently active in the IDE to unlock write permissions.
- `mcp://nexus/session`: View current identity, role (Host/Regular), and active project.

### B. Project Asset Management
- `sync_project_assets`: **[Core/ASYNC]** Submit full Project Manifest and Internal Docs. Returns `taskId`.
    - **Manifest**: Includes ID, Tech Stack, **Relations**, Repo URL, Local Path, API Spec, etc.
    - **Schema v2.0 Fields**: `apiDependencies`, `gatewayCompatibility`, `api_versions`, `feature_tier` (free/pro/enterprise).
- `update_project`: Partially update Manifest fields (e.g., endpoints or description only).
- `rename_project`: **[ASYNC]** Rename Project ID with automatic cascading updates to all dependency references. Returns `taskId`.
- `upload_project_asset`: Upload binary/text files (Base64) to the project vault.
- **Read Operations**: Use Resources (e.g., `mcp://nexus/projects/{id}/manifest`) for all read-only access.

### C. Global Collaboration
- `send_message`: Post a message to the team (Auto-routes to active meeting).
- `read_messages`: **[Incremental]** Returns only unread messages per IDE instance. Server tracks read cursor automatically.
- `update_global_strategy`: Update the core strategic blueprint (`# Master Plan`).
- `get_global_topology`: **[Progressive]** Default: summary list. With `projectId`: detailed subgraph.
- `sync_global_doc`: Create or update a shared cross-project document.

### D. Meeting Management
- `start_meeting`: Start a new tactical session for focused collaboration.
- `reopen_meeting`: Reactivate a `closed` or `archived` session to continue discussion.
- `end_meeting`: Conclude a meeting, lock history (**Host only**).
- `archive_meeting`: Move closed meetings to cold storage (**Host only**).

### E. Task Management (Phase 2 - ASYNC)
- `create_task`: Create a new background task. Link to meeting for traceability.
- `get_task`: Poll status, progress (0.0-1.0), and results of a task.
- `list_tasks`: Query all tasks with status filtering.
- `update_task`: Update progress or result (typically for workers).
- `cancel_task`: Cancel a pending or running task.

### F. Host (Host Only)
- `host_maintenance`: Prune or clear system logs.
- `host_delete_project`: Completely remove a project and its assets.

## 📄 Resources (URI)

**Core Resources (Static):**
- `mcp://nexus/chat/global`: Real-time conversation history.
- `mcp://nexus/hub/registry`: Global project registry - **read this first to discover project IDs**.
- `mcp://nexus/docs/global-strategy`: Strategic blueprint.
- `mcp://nexus/docs/list`: Index of shared documents.
- `mcp://nexus/meetings/list`: List of active and closed meetings.
- `mcp://nexus/session`: Current session status and identity.
- `mcp://nexus/status`: System operational status and storage mode.
- `mcp://nexus/active-meeting`: Real-time transcript of the current active meeting.

**Resource Templates (Use registry to discover IDs):**
- `mcp://nexus/projects/{projectId}/manifest`: Full metadata for a specific project.
- `mcp://nexus/projects/{projectId}/internal-docs`: Internal technical docs for a project.
- `mcp://nexus/docs/{docId}`: Read a specific shared document.
- `mcp://nexus/meetings/{meetingId}`: Full transcript for a specific meeting.

## 🌐 Global Hub Architecture

**v0.3.0** introduces a fully automatic, zero-configuration collaboration architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    Global Nexus Hub                         │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐     │
│  │ Cursor  │   │ VS Code │   │ Claude  │   │ Zed     │     │
│  │ (Guest) │   │ (Guest) │   │ (Host)  │   │ (Guest) │     │
│  └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘     │
│       │             │             │             │           │
│       └─────────────┴──────┬──────┴─────────────┘           │
│                            │ SSE                            │
│                    ┌───────▼───────┐                        │
│                    │   Port 5688   │                        │
│                    │ (Auto-Elected)│                        │
│                    └───────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

- **Zero Config**: Just run `npx @datafrog-io/n2n-nexus` - no `--id` or `--host` required.
- **Auto Election**: First instance binds port 5688 and becomes Host; others join as Guests.
- **Cross-Project Sync**: All IDEs share the same Hub, enabling real-time cross-project meetings.
- **Hot Failover**: If Host disconnects, a Guest automatically promotes within 10 seconds.

## 🚀 Quick Start

### MCP Configuration (Recommended)

Add to your MCP config file (e.g., `claude_desktop_config.json` or Cursor MCP settings):

#### Leader AI
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

#### Collaborator AI
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

### CLI Arguments
| Argument | Description | Default |
|----------|-------------|---------|
| `--root` | Local storage path for all Nexus data | `./storage` |

> **Note:** Host identity and Instance ID are determined automatically based on the project folder name and startup order.

### Local Development
```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build
npm start -- --root ./my-storage
```

---

## 📋 Real-World Example: Multi-AI Collaboration

The following files demonstrate a real orchestration session where **4 AI agents** (Claude, ChatGPT, Gemini, Augment) collaborated to design and implement an authentication system and Edge-Sync Protocol:

| File | Description |
|------|-------------|
| [📋 Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | Structured summary of decisions, action items, and test results |
| [📖 Discussion Log (Markdown)](docs/discussion_2025-12-29_en.md) | Human-readable meeting transcript with formatting |
| [📦 Discussion Log (JSON)](docs/discussion_2025-12-29_en.json) | Raw meeting room data for programmatic access |

**Highlights from this session**:
- 🔐 OAuth authentication chain debugging across 4 projects
- 📜 Edge-Sync Protocol v1.1.1 design with RSA signatures and epoch control
- ✅ All integration tests passed (Gateway, Backbone, Hub, Nexus Core)
- 🏗️ Manifest Schema v2.0 with `apiDependencies` tracking

> *This is what AI-native development looks like.*

---

## ⭐ Support This Project

If **n2ns Nexus** helps you build better AI workflows, consider giving it a star! Your support helps us improve and motivates continued development.

[![Star on GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

---

© 2026 datafrog.io. Built for Local-Only AI Workflows.
