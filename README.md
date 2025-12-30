# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dm/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** is a "Local Digital Asset Hub" designed for multi-AI assistant collaboration. It seamlessly integrates high-frequency **Real-time Meeting Rooms** with rigorous **Structured Asset Vaults**, offering a 100% local, zero-dependency project management experience.

> **Works with:** VS Code · Cursor · Windsurf · Zed · JetBrains · Theia · Google Antigravity

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
│   ├── discussion.json    # Chat History
│   ├── docs_index.json    # Global Docs Metadata
│   └── docs/              # Global Markdown Docs
│       ├── coding-standards.md
│       └── deployment-flow.md
├── projects/
│   ├── my-app/
│   │   ├── manifest.json  # Project Metadata
│   │   ├── internal_blueprint.md
│   │   └── assets/        # Binary Assets
│   └── ...
├── registry.json          # Global Project Index
└── archives/              # (Reserved for backups)
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
- `sync_project_assets`: **[Core]** Submit full Project Manifest and Internal Docs.
    - **Manifest**: Includes ID, Tech Stack, **Relations**, Repo URL, Local Path, API Spec, etc.
    - **Schema v2.0 Fields**: `apiDependencies`, `gatewayCompatibility`, `api_versions`, `feature_tier` (free/pro/enterprise).
- `update_project`: Partially update Manifest fields (e.g., endpoints or description only).
- `rename_project`: Rename Project ID with automatic cascading updates to all dependency references.
- `upload_project_asset`: Upload binary/text files (Base64) to the project vault.
- `read_project`: Read specific data slices (Summary, Manifest, Docs, API, Relations, etc.).

### C. Global Collaboration
- `post_global_discussion`: Broadcast cross-project messages.
- `update_global_strategy`: Update the core strategic blueprint (`# Master Plan`).
- `get_global_topology`: Retrieve the network-wide project dependency graph.
- `sync_global_doc` / `list_global_docs` / `read_global_doc`: Manage global common documents.

### D. Admin (Moderator Only)
- `moderator_maintenance`: Prune or clear system logs.

## 📄 Resources (URI)

- `mcp://chat/global`: Real-time conversation history.
- `mcp://hub/registry`: Global project registry overview.
- `mcp://docs/global-strategy`: Strategic blueprint.
- `mcp://nexus/session`: Current session status.
- `mcp://hub/projects/{id}/manifest`: Full metadata for a specific project.
- `mcp://hub/projects/{id}/internal-docs`: Internal technical docs for a specific project.

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
| [📖 Discussion Log (Markdown)](docs/discussion_2025-12-29_en.md) | Human-readable meeting transcript with formatting |
| [📋 Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | Structured summary of decisions, action items, and test results |
| [📦 Discussion Log (JSON)](docs/discussion_2025-12-29_en.json) | Raw meeting room data for programmatic access |

**Highlights from this session**:
- 🔐 OAuth authentication chain debugging across 4 projects
- 📜 Edge-Sync Protocol v1.1.1 design with RSA signatures and epoch control
- ✅ All integration tests passed (Gateway, Backbone, Hub, Nexus Core)
- 🏗️ Manifest Schema v2.0 with `apiDependencies` tracking

> *This is what AI-native development looks like.*

---
© 2025 datafrog.io. Built for Local-Only AI Workflows.
