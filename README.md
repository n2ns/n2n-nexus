# n2n-nexus

Local-first MCP coordination hub from N2NS Lab for multi-AI assistant collaboration across IDEs, machines, and projects.

[![npm version](https://img.shields.io/npm/v/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![npm total downloads](https://img.shields.io/npm/dt/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![license](https://img.shields.io/github/license/n2ns/n2n-nexus)](https://github.com/n2ns/n2n-nexus/blob/main/LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue)](https://modelcontextprotocol.io)
[![node version](https://img.shields.io/node/v/n2n-nexus)](https://nodejs.org)
[![DataFrog.io](https://datafrog.io/badges/datafrog.svg)](https://datafrog.io)

[中文版](./docs/README_zh.md)

---

> **One daemon. Many assistants. Shared project state.**

n2n-nexus is an open-source Model Context Protocol (MCP) coordination server for teams and developers who use multiple AI coding assistants. A long-running local daemon owns project state, meetings, messages, tasks, shared docs, and project assets. Lightweight MCP adapters connect each IDE or assistant to the same daemon.

Use it when Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, JetBrains, or other MCP-enabled clients need a shared local coordination layer instead of isolated per-chat context.

## Search-friendly positioning

If you are searching for:

- multi-agent MCP coordination
- multi-AI assistant collaboration
- local MCP coordination hub
- shared project context for AI coding agents
- cross-IDE MCP collaboration server
- local-first project registry for AI assistants
- meeting and task coordination for coding agents

n2n-nexus is designed for these goals: shared daemon state, stateless MCP adapters, project-aware collaboration, local storage, and cross-environment IDE workflows.

## What Is n2n-nexus?

n2n-nexus gives AI assistants a shared coordination workspace. Instead of each assistant keeping its own isolated conversation state, all connected MCP clients can read and write to the same local daemon.

**Quick summary**

- **Install**: `npx n2n-nexus daemon --port 5688`
- **Protocol**: Model Context Protocol (MCP), adapter-to-daemon HTTP bridge
- **Storage**: local filesystem plus SQLite under `~/.n2n-nexus` by default
- **Best for**: multi-assistant coding sessions, project handoffs, shared decisions, meeting notes, async tasks, project manifests
- **Not for**: cloud team chat, public project management SaaS, source code indexing, vector search, or remote database hosting

## Why Use It?

- Coordinate multiple AI assistants working on the same project.
- Share project manifests, internal notes, assets, and topology across IDEs.
- Keep decisions, proposals, and updates in a local meeting/message log.
- Run the daemon once and connect adapters from Windows, WSL, SSH hosts, VMs, or multiple editors.
- Avoid giving each assistant broad filesystem or backend access just to exchange context.

## Architecture

```text
┌──────────────────────────────────────┐
│          n2n-nexus daemon            │
│  Standalone HTTP server · always on  │
│  Owns data, tools, tasks, messages   │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (SSH/VM)
  Stateless adapter per IDE
```

- **Daemon is the source of truth**: start it once and keep it running.
- **MCP adapters are stateless**: each IDE starts an adapter through `npx`, then forwards tool calls to the daemon.
- **Cross-environment by design**: point `NEXUS_ENDPOINT` at the same daemon from different machines or shells. The daemon binds to localhost by default; use `--host 0.0.0.0` only on a trusted network.

## Quick Start

### 1. Start the daemon

```bash
npx n2n-nexus daemon --port 5688
```

### 2. Configure an MCP client

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

The adapter can start before the daemon. It loads the daemon tool list once the daemon becomes reachable.

### Cross-environment endpoint examples

| Scenario | `NEXUS_ENDPOINT` |
| --- | --- |
| Same machine | `http://127.0.0.1:5688` |
| WSL IDE to Windows daemon | `http://host.docker.internal:5688` |
| Windows IDE to WSL daemon | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |

## Toolset

### Session and context

- `register_session_context`: declare the active project ID.

### Project asset management

- `sync_project_assets`: submit a project manifest and internal docs.
- `update_project`: patch a project manifest.
- `rename_project`: rename a project ID and update relations.
- `upload_project_asset`: upload binary or text assets.
- `search_projects`: search the project registry.
- `get_global_topology`: inspect project topology and dependencies.

### Messaging and collaboration

- `send_message`: post meeting or global messages.
- `read_messages`: read unread messages incrementally.
- `update_global_strategy`: update the master strategy document.
- `sync_global_doc`: create or update shared docs.

### Meeting management

- `start_meeting`: open a meeting session.
- `end_meeting`: close and lock a meeting.
- `archive_meeting`: move a closed meeting to archive.
- `reopen_meeting`: reactivate a closed or archived meeting.

### Async task management

- `create_task`: create a background task.
- `get_task`: poll task status and result.
- `list_tasks`: list tasks by status.
- `cancel_task`: cancel a pending or running task.

### Maintenance

- `host_maintenance`: prune or clear system logs.
- `host_delete_project`: delete a project and assets.

## Data Storage

Default storage root:

| Platform | Path |
| --- | --- |
| Linux / WSL | `~/.n2n-nexus` |
| Windows | `%USERPROFILE%\.n2n-nexus` |
| macOS | `~/.n2n-nexus` |

Override with `--root <path>` or `NEXUS_ROOT`.

```text
~/.n2n-nexus/
├── global/
│   ├── blueprint.md
│   ├── docs_index.json
│   └── docs/
├── projects/
│   └── {project-id}/
│       ├── manifest.json
│       ├── internal_blueprint.md
│       └── assets/
├── registry.json
└── nexus.db
```

## Project ID Conventions

Project IDs follow `[prefix]_[name]`.

| Prefix | Category | Example |
| --- | --- | --- |
| `web_` | Websites | `web_datafrog.io` |
| `api_` | Backend services | `api_user-auth` |
| `mcp_` | MCP servers | `mcp_nexus` |
| `lib_` | Libraries / SDKs | `lib_crypto-core` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VS Code extensions | `vscode_super-theme` |
| `desktop_` | Desktop apps | `desktop_main-hub` |
| `infra_` | Infrastructure / DevOps | `infra_k8s-config` |
| `doc_` | Documentation | `doc_coding-guide` |

## CLI Reference

```bash
# Start daemon
n2n-nexus daemon [--port 5688] [--root ~/.n2n-nexus] [--host 127.0.0.1]

# Start MCP adapter
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp
```

### Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | Daemon URL for MCP adapter | `http://127.0.0.1:5688` |
| `NEXUS_ROOT` | Storage root for daemon | `~/.n2n-nexus` |
| `NEXUS_HOST` | Daemon bind host | `127.0.0.1` |
| `NEXUS_INSTANCE_ID` | Override MCP instance ID | auto-generated |

## Security and governance notes

- n2n-nexus stores coordination data locally by default.
- Do not put secrets, credentials, customer data, or private tokens in meeting messages or project assets unless your local policy allows it.
- Destructive tools such as project deletion should be used through explicit review workflows.
- Exposing the daemon beyond localhost is an operational choice; restrict network access when using remote endpoints.
- Treat project manifests and internal docs as potentially sensitive implementation data.

## Real-world example

The docs include a sample multi-agent session where several AI assistants collaborated on architecture and protocol decisions:

| File | Description |
| --- | --- |
| [Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | Structured decisions and test notes |
| [Discussion Log](docs/discussion_2025-12-29_en.md) | Human-readable discussion transcript |

## Local Development

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# Run daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Run MCP adapter
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

## FAQ

### Is n2n-nexus a project management SaaS?

No. It is a local MCP coordination server for AI assistants. It stores state locally and exposes MCP tools to connected clients.

### Does it replace n2n-memory?

No. `n2n-memory` is repository-local memory for one project. `n2n-nexus` is a shared coordination hub for multiple assistants, project manifests, messages, meetings, and tasks.

### Does it work with Claude Desktop, Cursor, VS Code, and other IDEs?

Yes, when the client supports local MCP command servers. The adapter is started by the IDE and connects to the local daemon through `NEXUS_ENDPOINT`.

### Can it coordinate assistants across Windows and WSL?

Yes. Run the daemon in one environment and point each adapter at it using `NEXUS_ENDPOINT`.

### Does it send data to the cloud?

No cloud service is required. Data is stored under the configured local root. If you expose the daemon to a remote machine, that is your own network configuration.

### Is this a vector database or code indexer?

No. n2n-nexus coordinates project metadata, messages, meetings, docs, tasks, and assets. It is not a semantic code search engine.

## Related docs

- [Architecture](./docs/ARCHITECTURE.md)
- [AI Assistant Guide](./docs/ASSISTANT_GUIDE.md)
- [Chinese README](./docs/README_zh.md)
- [Changelog](./CHANGELOG.md)
- [llms.txt](./llms.txt)

## License

This project is licensed under the [Apache-2.0 License](./LICENSE).

---

Built by N2NS Lab, short for Next-to-Native Systems Lab, Datafrog's open-source lab for practical AI developer tools.
