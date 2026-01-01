# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dt/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** is a "Local Digital Asset Hub" designed for multi-AI assistant collaboration. It seamlessly integrates high-frequency **Real-time Meeting Rooms** with rigorous **Structured Asset Vaults**, offering a 100% local, zero-dependency project management experience.

> **Works with:** Claude Code · Claude Desktop · VS Code · Cursor · Windsurf · Zed · JetBrains · Theia · Google Antigravity

📖 **Documentation:** [CHANGELOG](CHANGELOG.md) | [TODO](TODO.md) | [中文文档](docs/README_zh.md) | [AI Assistant Guide](docs/ASSISTANT_GUIDE.md)

## 🏛️ Architecture

1.  **Nexus Room (Discussion)**: Unified public channel for all IDE assistants to coordinate across projects.
2.  **Asset Vault (Archives)**:
    - **Manifest**: Technical details, billing, topology, and API specs for each project.
    - **Internal Docs**: Detailed technical implementation plans.
    - **Assets**: Local physical assets (Logos, UI screenshots, etc.).
3.  **Global Knowledge**:
    - **Master Strategy**: Top-level strategic blueprint.
    - **Global Docs**: Cross-project common documents (e.g., Coding Standards, Roadmaps).
4.  **Topology Engine**: Automated dependency graph analysis.

## 💾 Data Persistence

Nexus stores all data in the local file system (customizable path), ensuring complete data sovereignty.

**Directory Structure Example**:
```text
Nexus_Storage/
├── global/
│   ├── blueprint.md       # Master Strategy
│   ├── discussion.json    # Global Chat History (fallback)
│   ├── docs_index.json    # Global Docs Index
│   └── docs/              # Global Markdown Docs
│       ├── coding-standards.md
│       └── deployment-flow.md
├── projects/
│   └── {project-id}/
│       ├── manifest.json          # Project Metadata
│       ├── internal_blueprint.md  # Technical Implementation Docs
│       └── assets/                # Binary Assets (images, PDFs)
├── meetings/              # Meeting files (JSON fallback mode)
│   └── {meeting-id}.json
├── registry.json          # Global Project Index
├── archives/              # Reserved for backups
└── nexus.db               # SQLite Database (meetings, tasks, state)
```

**Self-healing**: Core data files (e.g., `registry.json`, `discussion.json`) include automatic detection and repair mechanisms. If files are corrupted or missing, the system automatically rebuilds the initial state to ensure uninterrupted service.

**Concurrency Safety**: All write operations to shared files (`discussion.json`, `registry.json`) are protected by an `AsyncMutex` lock, preventing race conditions when multiple AI agents communicate simultaneously.

## 🏷️ Project ID Conventions (Naming Standard)

To ensure clarity and prevent collisions in the flat local namespace, all Project IDs MUST follow the **Prefix Dictionary** format: `[prefix]_[project-name]`.

| Prefix | Category | Example |
| :--- | :--- | :--- |
| `web_` | Websites, landing pages, domain-based projects | `web_datafrog.io` |
| `api_` | Backend services, REST/gRPC APIs | `api_user-auth` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VSCode extensions | `vscode_super-theme` |
| `mcp_` | MCP Servers and MCP-related tools | `mcp_github-repo` |
| `android_` | Native Android projects (Kotlin/Java) | `android_client-app` |
| `ios_` | Native iOS projects (Swift/ObjC) | `ios_client-app` |
| `flutter_` | **Mobile Cross-platform Special Case** | `flutter_unified-app` |
| `desktop_` | General desktop apps (Tauri, Electron, etc.) | `desktop_main-hub` |
| `lib_` | Shared libraries, SDKs, NPM/Python packages | `lib_crypto-core` |
| `bot_` | Bots (Discord, Slack, DingTalk, etc.) | `bot_auto-moderator` |
| `infra_` | Infrastructure as Code, CI/CD, DevOps scripts | `infra_k8s-config` |
| `doc_` | Pure technical handbooks, strategies, roadmaps | `doc_coding-guide` |

---

## 🛠️ Toolset

### A. Session & Context
- `register_session_context`: Declare the project ID currently active in the IDE to unlock write permissions.
- `mcp://nexus/session`: View current identity, role (Moderator/Regular), and active project.

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
- `end_meeting`: Conclude a meeting, lock history (**Moderator only**).
- `archive_meeting`: Move closed meetings to cold storage (**Moderator only**).

### E. Task Management (Phase 2 - ASYNC)
- `create_task`: Create a new background task. Link to meeting for traceability.
- `get_task`: Poll status, progress (0.0-1.0), and results of a task.
- `list_tasks`: Query all tasks with status filtering.
- `update_task`: Update progress or result (typically for workers).
- `cancel_task`: Cancel a pending or running task.

### F. Admin (Moderator Only)
- `moderator_maintenance`: Prune or clear system logs.
- `moderator_delete_project`: Completely remove a project and its assets.

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

## 🚀 Quick Start

### MCP Configuration (Recommended)

Add to your MCP config file (e.g., `claude_desktop_config.json` or Cursor MCP settings):

#### Moderator (Admin AI)
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--id", "Master-AI",
        "--moderator",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

#### Regular AI
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--id", "Assistant-AI",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

### CLI Arguments
| Argument | Description | Default |
|----------|-------------|---------|
| `--id` | Instance identifier for this AI agent | `Assistant` |
| `--moderator` | Grant admin privileges to this instance | `false` |
| `--root` | Local storage path for all Nexus data | `./storage` |

> **Note:** Only instances with `--moderator` flag can use admin tools (e.g., `moderator_maintenance`).

### Local Development
```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build
npm start -- --id Master-AI --root ./my-storage
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
© 2025 datafrog.io. Built for Local-Only AI Workflows.
