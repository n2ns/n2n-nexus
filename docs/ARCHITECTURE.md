# Architecture & Standards

## 🏛️ Architecture

1.  **Nexus Room (Discussion)**: Unified public channel for all IDE assistants to coordinate across projects.
2.  **Asset Vault (Archives)**:
    -   **Manifest**: Technical details, billing, topology, and API specs for each project.
    -   **Internal Docs**: Detailed technical implementation plans.
    -   **Assets**: Local physical assets (Logos, UI screenshots, etc.).
3.  **Global Knowledge**:
    -   **Master Strategy**: Top-level strategic blueprint.
    -   **Global Docs**: Cross-project common documents (e.g., Coding Standards, Roadmaps).
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

## 🌐 Host-Guest Network Architecture (v2)

### Zero-Config Startup & Election
The system aims for a "magic" user experience where multiple instances on the same machine automatically discover each other without manual configuration.

1.  **Parallel Race Election**: Upon startup, every instance scans the first 5 ports (5688-5692) concurrently (<300ms).
2.  **Role Resolution**:
    *   **Host**: If a port is free, the instance binds it and becomes the Host.
    *   **Guest**: If a Host is found, the instance connects via SSE (Server-Sent Events) and becomes a Guest.
3.  **Immediate Handshake**: The `StdioServerTransport` connects immediately (<10ms) to the IDE. Static requests (`tools/list`) are served locally, preventing IDE timeouts. Dynamic requests are **buffered** until the election concludes.

### Failover & Resilience
*   **Smart Proxy**: Guest instances proxy IDE requests to the Host via HTTP/SSE. They handle backpressure and buffering to prevent data loss during connection blips.
*   **Auto-Failover**: If the Host process terminates (e.g., user closes the Host IDE window), Guest instances detect the connection loss (via `ECONNREFUSED` or SSE `end`) and trigger a **Re-Election**. One of the surviving Guests will promote itself to become the new Host, restoring the cluster automatically.
