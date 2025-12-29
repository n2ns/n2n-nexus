# Changelog

All notable changes to this project will be documented in this file.

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
