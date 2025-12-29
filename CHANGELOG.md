# Changelog

All notable changes to this project will be documented in this file.

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
