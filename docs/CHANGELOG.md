# Changelog

All notable changes to this project will be documented in this file.

## [v0.1.9] - 2025-12-30

### 🛡️ Collaboration & Security
- **Initiator-only Permissions**: Implemented restricted access for `end_meeting` and `archive_meeting`. Only the meeting creator or a system moderator can conclude a session.
- **Session Presence Awareness**: Automated `[ONLINE/OFFLINE]` status messages in the global log when an IDE session starts or terminates, improving visibility for concurrent agents.
- **Clean Tool Naming**: Finalized the transition to `send_message` and `read_messages`, removing all deprecated discussion tool aliases.

### 🌐 Resource Namespacing (MCP 2025 Standard)
- **Unified Authority**: All core resource URIs migrated to `mcp://nexus/` to ensure naming isolation in multi-server environments.
- **New Resources**: Added `mcp://nexus/status` and `mcp://nexus/active-meeting` for instant tactical context without tool calls.

## [v0.1.9] - 2025-12-30

### 🛡️ Collaboration & Security
- **Initiator-only Permissions**: Implemented restricted access for `end_meeting` and `archive_meeting`. Only the meeting creator or a system moderator can conclude a session.
- **Session Presence Awareness**: Automated `[ONLINE/OFFLINE]` status messages in the global log when an IDE session starts or terminates, improving visibility for concurrent agents.
- **Clean Tool Naming**: Finalized the transition to `send_message` and `read_messages`, removing all deprecated discussion tool aliases.

### 🌐 Resource Namespacing (MCP 2025 Standard)
- **Unified Authority**: All core resource URIs migrated to `mcp://nexus/` to ensure naming isolation in multi-server environments.
- **New Resources**: Added `mcp://nexus/status` and `mcp://nexus/active-meeting` for instant tactical context without tool calls.

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
