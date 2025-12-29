# n2ns Nexus (v0.1.0) 🚀

**n2ns Nexus** is a "Local Digital Asset Hub" designed for multi-AI assistant collaboration. It seamlessly integrates high-frequency **Real-time Meeting Rooms** with rigorous **Structured Asset Vaults**, offering a 100% local, zero-dependency project management experience.

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

## 🛠️ Toolset

### A. Session & Context
- `register_session_context`: Declare the project ID currently active in the IDE to unlock write permissions.
- `mcp://nexus/session`: View current identity, role (Moderator/Regular), and active project.

### B. Project Asset Management
- `sync_project_assets`: **[Core]** Submit full Project Manifest and Internal Docs.
    - **Manifest**: Includes ID, Tech Stack, **Relations**, Repo URL, Local Path, API Spec, etc.
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

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--id", "Master-AI",
        "--moderator-id", "Master-AI",
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
| `--moderator-id` | ID of the moderator (has admin rights) | *(none)* |
| `--root` | Local storage path for all Nexus data | `./storage` |

### Local Development
```bash
git clone https://github.com/n2ns/n2ns-nexus.git
cd n2ns-nexus
npm install
npm run build
npm start -- --id Master-AI --root ./my-storage
```

---
© 2025 Antigravity Dev Team. Built for Local-Only AI Workflows.
