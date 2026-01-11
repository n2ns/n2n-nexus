# Changelog

All notable changes to this project will be documented in this file.

## [0.3.8] - 2026-01-11
### 🚀 Online First Architecture
- **Performance**: Removed top-level blocking await for election. Server now starts in <300ms (Online First), reducing startup time by 99% in congested networks.
- **Stability**: Fixed "Timeout" errors in MCP clients (Cursor/Claude) by ensuring `tools/list` is available immediately before Host Election completes.
- **Race Condition Fix**: Implemented explicit server shutdown before transitioning from Local to Guest mode to prevent Stdio stream conflicts.
- **Refactor**: Moved `isHost` logic from static config to dynamic `updateConfig` flow.


## [0.3.5] - 2026-01-10
### Protocol & Stability
- **Fix (Zombie Host)**: Implemented "Intelligent Retry" and "Re-Election" logic. If a Guest repeatedly connects to a Zombie Host (handshake OK, SSE broken), it will now automatically trigger a re-election process, blacklist the bad port, and promote itself to Host on a new port if necessary.
- **Refactor**: Enabled dynamic role switching (Guest -> Host) without process restart.

## [0.3.4] - 2026-01-10
### Protocol & Stability
- **New Handshake Protocol**: Introduced `POST /nexus/handshake` to replace legacy `/hello`. Supports strict versioning (Client/Server) and robust Host detection.
- **Global Error Safety Net**: Implemented `uncaughtException` and `unhandledRejection` handlers to prevent process exits from background task errors, ensuring high availability of the Hub.
- **Fix (EOF Error)**: Resolved "Connection Closed: EOF" crashes caused by non-idempotent SQLite initialization during repeated tool calls.
- **Fix (Zombie Host)**: Eliminated infinite retry loops by improving Guest's host detection logic.
- **Test Coverage**: Added `guest_connection.test.ts` to verify Guest-Host SSE integration.

## [0.3.3] - 2026-01-10
### 🔄 Zero-Config Persistence
- **XDG Base Directory Support**: Moved valid storage location from ephemeral `node_modules` to system-standard user data paths:
  - **Linux/WSL**: `~/.local/share/n2n-nexus`
  - **Windows**: `%APPDATA%\n2n-nexus`
  - **macOS**: `~/Library/Application Support/n2n-nexus`
- **Data Persistence**: Data now survives `npx` cache clearing, project deletion, and re-installations.
- **Bind Address**: Changed default listener to `0.0.0.0` to support WSL Mirror Mode networking.
- **Identity Safety**: Default "Assistant" ID now appends a random suffix (e.g., `Assistant-x9a2`) to prevent conflicts when multiple empty IDEs connect.

## [0.3.8] - 2026-01-11

### Fixed
- **Guest Proxy Framing**: Implemented proper message framing (newline-delimited JSON buffer) in Guest-to-Host proxy. This resolves "context deadline exceeded" timeouts in IDEs where stdin pipes fragment JSON-RPC messages.

## [0.3.7] - 2026-01-08
### Security & Stability
- **Security**: Fixed potential URL parameter injection in Guest proxy connection URL.
- **Stability**: Refactored host election fallback loop from async recursion to `while(true)` to prevent long-term stack overflow.
- **Refactor**: Improved code structure in `config.ts` for better maintainability.

## [0.3.1] - 2026-01-08
### Fixed
- **Critical**: Recursive stack overflow in Guest proxy reconnection logic (partial fix).
- **Critical**: Server crash when fallback port binding fails (now retries with backoff).
- **Performance**: Optimized port scanning with batch concurrency (56s -> 3s scan time).
- **Config**: Expanded port range to 5688-5800 (113 ports).

## [v0.3.0] - 2026-01-08

### 🌐 Global Hub Architecture (Zero-Config Multi-IDE Collaboration)

This release introduces a fully automatic Host election and Global Hub architecture, enabling seamless multi-IDE collaboration without any configuration.

#### Automatic Host Election (Port-Based)
- **Port Range 5688-5700**: First instance to bind becomes Host, others become Guests.
- **Probe-First Strategy**: Guests scan for existing Host before attempting to bind, eliminating race conditions.
- **Hello Handshake**: `/hello` endpoint validates Nexus identity, distinguishing from other services.
- **10s Failover Window**: On bind failure, Guests wait 10 seconds then re-probe to join the winner.

#### Global Hub (SSE-Based Communication)
- **Single Hub Architecture**: All IDEs (regardless of project) connect to the same Host for cross-project collaboration.
- **Stdio-to-SSE Proxy**: Guests transparently forward IDE traffic to Host via SSE.
- **Multi-Session Routing**: Host maintains session map for concurrent Guest connections.
- **Storage Path Inheritance**: Host broadcasts `rootStorage` path; Guests inherit it for seamless failover.

#### Heartbeat & Watchdog (High Availability)
- **Host Heartbeat**: Host sends `: ping` every 30 seconds to keep connections alive.
- **Guest Watchdog**: Guests monitor activity; if silent for 60 seconds, trigger automatic re-election.
- **Hot Failover**: Surviving Guests automatically promote to new Host using inherited storage path.

#### Terminology Refactoring
- **Moderator → Host**: All code, tests, and documentation updated.
- **`isModerator` → `isHost`**: API and config properties renamed.
- **`moderator_*` → `host_*`**: Tool names updated (e.g., `host_maintenance`).

#### Zero-Config Experience
- **`--id` Deprecated**: Instance ID now auto-derived from project folder name.
- **`--host` Removed**: Host role determined automatically by port binding.
- **Simplified CLI**: Just `npx @datafrog-io/n2n-nexus` to get started.

| Metric | Before | After |
|--------|--------|-------|
| Required CLI Args | 2-3 | 0-1 |
| Manual Host Setup | Required | Automatic |
| Multi-IDE Sync | File-based | SSE Real-time |
| Failover Time | Manual restart | < 10 seconds |

#### Test Coverage
- New `election.test.ts` with 9 test cases covering probe, bind, and race scenarios.
- All 55 tests passing.

## [v0.2.1] - 2026-01-01

### 🚀 Token Economy Deep Optimization

This release focuses on reducing context window consumption when AI loads the MCP server.

#### Tool Definition Optimization (-49% Token Reduction)
- **Hand-Crafted Schemas**: Replaced `Zod.toJSONSchema()` with manually optimized `definitions.ts`.
- **Removed $schema Spam**: Eliminated redundant `$schema` declarations per tool (~50 chars saved per tool).
- **Concise Descriptions**: Reduced average description length by 50%.
- **Hidden Internal Tools**: `update_task` (marked `[INTERNAL]`) excluded from public `ListTools`.

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Tool Definitions | 10,241 chars | 5,237 chars | **-49%** |
| Approx Tokens | ~2,560 | ~1,310 | **-1,250 tokens** |

#### Incremental Message Reading
- **Read Cursors Table**: New `read_cursors` SQLite table tracks each IDE's last read message ID per meeting.
- **Auto-Increment**: `read_messages` automatically returns only unread messages based on `instanceId`.
- **Zero Config**: No `afterId` parameter needed - cursor managed entirely server-side.
- **Response Enhancement**: Returns `{ newMessages: N, messages: [...] }` for easy verification.

#### Context7-Style Progressive Loading
- **`get_global_topology` Upgrade**:
  - **Default (List Mode)**: Returns lightweight summary `{ totalProjects, totalEdges, projects: [{id, name}] }`.
  - **Focused Mode**: Pass `projectId` to get detailed subgraph for that specific project.
- **`listResources` Optimization**:
  - **O(1) Scaling**: Resource list size is now constant regardless of project count.
  - **Static Resources**: Fixed 8 core resources (chat, registry, docs, meetings, etc.).
  - **Template-Based Projects**: Individual projects no longer dynamically listed; use templates instead.
  - **Discovery Flow**: AI reads `hub/registry` → discovers project IDs → constructs URI from template.

| Scenario | Before | After |
|----------|--------|-------|
| 0 projects | 8 resources | 8 resources + 4 templates |
| 20 projects | 28 resources | 8 resources + 4 templates (fixed) |
| 50 projects | 58 resources | 8 resources + 4 templates (fixed) |

#### Documentation
- Updated `README.md` with new tool behaviors (`[Incremental]`, `[Progressive]`).
- Updated `ASSISTANT_GUIDE.md` to v0.2.1 with "渐进式发现，增量读取" principle.
- Reorganized Resources section with Core Resources + Resource Templates structure.

## [v0.2.0] - 2025-12-31

### 🚀 Task Primitive System (Phase 2 & 3)
- **Async Deepening**: Critical blocking operations (`rename_project`, `moderator_delete_project`) migrated to the Task primitive with background cascading updates.
- **Traceability**: All tasks now support `source_meeting_id` to link execution back to meeting decisions.
- **Progressive UI**: Added `progress` tracking (0.0-1.0) and `result_uri` for structured task output.
- **Lifecycle Tools**: Added `create_task`, `get_task`, `list_tasks`, `update_task`, and `cancel_task`.

### 🛡️ Type Safety & Security
- **Defense-in-Depth**: Implemented secondary permission gates inside `handleRemoveProject` and `handleModeratorMaintenance` for maximum project isolation.
- **Meeting Hardening**: `end_meeting` and `archive_meeting` are now strictly **Moderator-only**.
- **Zod integration**: All tool definitions migrated to strictly-typed Zod schemas with regex path-traversal protection.
- **Infrastructure**: Modernized toolchain to **TypeScript 5.9.3**, **Vitest 4.0.16**, and **ESLint 9.39.2**.

### ✂️ Code Diet (Architectural Cleanliness)
- **The Great Purge**: Removed 6 redundant tools (`list_projects`, `read_project`, `list_global_docs`, `read_global_doc`, `list_meetings`, `read_meeting`) in favor of Resource URIs.
- **Native Zod 4 Schemas**: Removed `zod-to-json-schema` dependency; now using native Zod 4 `toJSONSchema()` generation.

## [v0.1.9] - 2025-12-30

### 🛡️ Collaboration & Security
- **Initiator-only Permissions**: Implemented restricted access for `end_meeting` and `archive_meeting`.
- **Session Presence Awareness**: Automated `[ONLINE/OFFLINE]` status messages in global logs.
- **Clean Tool Naming**: Finalized transition to `send_message` and `read_messages`.

### 🌐 Resource Namespacing (MCP 2025 Standard)
- **Unified Authority**: All core resource URIs migrated to `mcp://nexus/`.
- **New Resources**: Added `mcp://nexus/status` and `mcp://nexus/active-meeting`.

## [v0.1.8] - 2025-12-30

### 🎯 Meeting Architecture (Phase 1 & 2)
- **Hybrid Storage Backend**: Automatic selection between **SQLite** (preferred) and **JSON Fallback**.
- **SQLite Engine**: Powered by `better-sqlite3` with **WAL mode** for high-concurrency and multi-process safety.
- **New Lifecycle Entity**: `MeetingSession` replaces monolithic chat logs with discrete sessions.
- **Lifecycle Tools**:
  - `start_meeting(topic)`: Creates dedicated session with unique ID and random entropy.
  - `end_meeting(meetingId?, summary?)`: Closes meeting, collects decisions.
  - `archive_meeting(meetingId)`: Moves sessions to historical archives.
  - `list_meetings(status?)`: Filtered discovery of sessions.
  - `read_meeting(meetingId)`: Detailed retrieval of history, participants, and decisions.

### 🏗️ API & Storage Improvements
- **Structured JSON Responses**: Meeting tools now return machine-readable JSON for better agent integration.
- **Smart Auto-Routing**: Global discussion messages are automatically routed to active meetings.
- **ID Generation**: Robust slug generation with Base64 fallback for non-ASCII topics (Chinese/Unicode).
- **Concurrency Control**: Shared `AsyncMutex` utility and native SQLite locking.
- **Status Reporting**: `mcp://nexus/status` now reports `storage_mode` and `is_degraded` flags.

### 🧪 Quality Assurance
- **Comprehensive Test Suite**: Added 24+ integration and stress tests (100% Green).
- **Concurrency Stress Tests**: Validated data integrity under rapid message bursts.
- **Fallback Verification**: Confirmed system stability when native modules are unavailable.

### 🛡️ Security
- **Hardened Project Deletion**: Renamed `delete_project` to `moderator_delete_project` and enforced explicit moderator validation to prevent unauthorized project destruction.
- **Path Sanitization**: Enhanced error handling to strip absolute local file paths from MCP error messages.

### 📄 Resources & Documentation
- **New Resource**: Added `mcp://nexus/active-meeting` for instant access to the current meeting transcript and decisions.
- **Improved Tooling UX**: Documented return value structures and administrative requirements in tool definitions.
- **Manuals**: Updated `ASSISTANT_GUIDE.md` and both README versions with new admin tool documentation and Phase 2 best practices.

## [v0.1.7] - 2025-12-30

### ⚙️ CLI Simplification
- **Moderator flag**: Replaced `--moderator-id <id>` with simple `--moderator` boolean flag.
  - Moderator: `--id Master-AI --moderator`
  - Regular AI: `--id Assistant-AI` (no extra flag needed)

### ✅ Tests
- Added session resource tests for role verification (Moderator/Regular).
- All 17 unit tests passing.

## [v0.1.6] - 2025-12-29

### 🔒 Concurrency Safety
- **AsyncMutex Lock**: Implemented mutex-based concurrency control to prevent race conditions during simultaneous file writes.
- Protected write operations:
  - Discussion: `addGlobalLog()`, `pruneGlobalLogs()`, `clearGlobalLogs()`
  - Registry: `saveProjectManifest()`, `renameProject()`, `deleteProject()`

### 📦 Schema v2.0
- **Manifest Schema Enhancements**: Added new optional fields for enterprise coordination:
  - `apiDependencies`: Map of projectId to version constraint (e.g., `">=v2.1"`)
  - `gatewayCompatibility`: Gateway version compatibility string
  - `api_versions`: Feature-level API versions
  - `feature_tier`: Capability tier declaration (`"free"` | `"pro"` | `"enterprise"`)

## [v0.1.5] - 2025-12-29

### 🚀 Major Features
- **Project ID Naming Convention**: Enforced `[prefix]_[technical-name]` standard with 13 type prefixes (web_, api_, chrome_, vscode_, mcp_, android_, ios_, flutter_, desktop_, lib_, bot_, infra_, doc_).
- **MCP Prompts Capability**: Added `init_project_nexus` prompt for guiding AI through proper project registration workflow.
- **delete_project Tool**: New admin tool for complete project removal (manifest, assets, registry entry).

### 🔒 Guardrails
- Added `validateProjectId()` with runtime regex validation in `handleRegisterSession`, `handleSyncProjectAssets`, and `handleRenameProject`.
- Projects with invalid ID formats are now rejected at the API level.

### ✨ Enhancements
- Resource names now display project type icons (e.g., "🌐 Website: web_example.com").
- Handler unit tests expanded to cover delete, rename, and validation scenarios.

### 📄 Documentation
- Added "Project ID Conventions" section to README.md.
- Updated tool descriptions with Prefix Dictionary guidance.

## [v0.1.4] - 2025-12-29

### 🐛 Bug Fix
- Added shebang (`#!/usr/bin/env node`) to fix npx execution on Windows.

## [v0.1.3] - 2025-12-29

### 🔧 CI/CD
- Switched to npm Trusted Publishing (OIDC) - no more NPM_TOKEN needed.
- Upgraded to Node.js 22 for npm 11.5.1+ support.
- Added `--provenance` flag for supply chain security.

## [v0.1.2] - 2025-12-29

### 🔧 Refactoring
- Modularized codebase into `tools/`, `resources/`, and `storage/` modules.
- Reduced `index.ts` from 535 to 115 lines.
- Moved tests from `src/__tests__/` to top-level `tests/` directory.

### 📦 CI/CD
- Changed GitHub Actions trigger from `release` to tag push (`v*`).

### 📄 Documentation
- Added npm downloads badge.
- Fixed repository URLs to `n2n-nexus`.

## [v0.1.1] - 2025-12-29

### 📦 npm Release
- Published to npm as `@datafrog-io/n2n-nexus`.
- Updated README with `npx` configuration for easy MCP integration.
- Added CLI arguments documentation table.

## [v0.1.0] - 2025-12-29

### 🚀 Major Features
- **Project Asset Hub**: Centralized storage for Project Manifests, Internal Docs, and Assets (Images/Files).
- **Communication Channels**:
    - `mcp://chat/global`: Real-time inter-agent messaging stream.
    - `post_global_discussion`: Broadcast tool for coordination.
- **Topology Engine**:
    - `get_global_topology`: Auto-generates dependency graphs based on manifest `relations`.
- **Global Knowledge Base**:
    - New `docs/` directory structure for shared standards.
    - Tools: `sync_global_doc`, `read_global_doc`, `list_global_docs`.
- **Self-Healing Storage**:
    - Automatic repair of corrupted JSON registries or logs.
    - Safe-defaults for missing configurations.

### 🛠️ Tooling
- Added `update_project` for partial manifest patches.
- Added `rename_project` with auto-cascading reference updates across all projects.
- Added `register_session_context` for IDE session binding.
- Added `moderator_maintenance` for log pruning.

### 📚 Documentation
- Updated `README.md` with complete architecture diagrams and data persistence details.
- Added `ASSISTANT_GUIDE.md` for AI-to-AI operational protocols.
