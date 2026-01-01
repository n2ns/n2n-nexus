# Nexus Project TODO List

## 📅 2025-12-31: Token Economy & API Surface Optimization

**Objective**: Reduce the static Token cost of the MCP server by migrating "Read" operations from Tools to Resources.

### 1. Tool to Resource Migration (Phase 1 - DONE)
- [x] **Standardize Resource URIs**:
    - [x] Implementation of `mcp://nexus/meetings/list` and `mcp://nexus/docs/list`.
    - [x] Support for dynamic resource URIs across projects and docs.
- [x] **Deprecate Redundant Tools**:
    - [x] Successfully removed `list_projects`, `list_meetings`, `list_global_docs`.
    - [x] Successfully removed `read_project`, `read_global_doc`, `read_meeting`.

### 2. Implementation Strategy

#### Phase 1: Resource Migration (DONE)
- [x] **Tool Purge**: Removed tools instead of just deprecating them (cleaner API).
- [x] **Internal Refactor**: Underlying storage methods optimized for resource-based lazy loading.
- [x] **Assistant Guide Sync**: Update `ASSISTANT_GUIDE.md` to v0.2.0 Task-first discovery.

#### Phase 1.5: Type Safety Hardening (DONE)
- [x] **Integrate Zod**: Installed `zod` and `zod-to-json-schema`.
- [x] **Schema Migration**: Moved tool definitions to `schemas.ts` with strict Zod validation.
- [x] **Runtime Validation**: Enforced Zod parsing in tool handlers.

#### Phase 2: Task Primitive (DONE)
- [x] **Architecture**: Separated "Meetings" (Context) from "Tasks" (Execution).
- [x] **Database**: Created `tasks` table with Lifecycle tracking.
- [x] **Service Layer**: Implemented `TaskService` for CRUD and status management.
- [x] **Trigger Fix**: Added `CREATE TRIGGER tasks_updated_at` for auto-updating timestamps.
- [x] **Global Init**: Moved `initTasksTable()` to `StorageManager.init()` (dynamic import).
- [x] **5 New Tools**: `create_task`, `get_task`, `list_tasks`, `update_task`, `cancel_task`.
- [x] **Async Migration**: `sync_project_assets` now returns taskId (non-blocking).

#### Phase 2.5: Security Hardening (DONE)
- [x] **ProjectIdSchema**: Applied to `read_project`, `update_project`, `rename_project.oldId`, `moderator_delete_project`.
- [x] **FileNameSchema**: Added for `upload_project_asset.fileName` (path traversal protection).
- [x] **Tool Tags**: `update_task` marked as `[INTERNAL]` to prevent misuse.

#### Phase 3: Infrastructure & Security (DONE)
- [x] **Resource Deprecation**: Removed 6 redundant read tools (`list_projects`, `read_project`, etc.) in favor of Resource URIs.
- [x] **Async Migration (Deepening)**: `rename_project` and `moderator_delete_project` refactored to use Task primitive.
- [x] **Meeting Management Enhancement**: Added `reopen_meeting` functionality (open to all participants) and strictly enforced Moderator-only permissions for `end_meeting` and `archive_meeting`.
- [x] **Version Bump**: Released v0.2.0 with Phase 2/3 features (2025-12-31).

#### Phase 4: Future Roadmap (Backlog)
- [ ] **More Async Candidates**: Consider migrating `upload_project_asset` to async pattern.
- [ ] **Task Cleanup Job**: Implement scheduled cleanup for expired/completed tasks.
- [ ] **Streaming Progress**: Support periodic task progress notifications via MCP resources.

---

## 📅 2026-01-01: Token Economy Deep Optimization

**Problem**: Claude Desktop context window explodes when loading n2n-nexus MCP server.

### Root Cause Analysis

1. **Zod `toJSONSchema()` Bloat**: 
   - Each tool's `inputSchema` included redundant `$schema` declarations
   - `ProjectIdSchema` was inlined (expanded) in every usage instead of using `$ref`
   - Generated schemas contained verbose `additionalProperties: false` on every object

2. **Tool Description Verbosity**:
   - Original descriptions averaged 80+ chars per tool
   - Total tool definitions: ~10,241 chars (~2,560 tokens)

3. **Internal Tool Exposure**:
   - `update_task` (marked `[INTERNAL]`) was still exposed in `ListTools`

### Optimization Results (DONE)

- [x] **Hand-Crafted Tool Definitions**: Replaced `zod.toJSONSchema()` with minimal `definitions.ts`
- [x] **Concise Descriptions**: Reduced average description length by 50%
- [x] **Hidden Internal Tools**: `update_task` excluded from public `TOOL_DEFINITIONS`
- [x] **Removed $schema Spam**: Eliminated per-tool `$schema` declarations

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Tool Definitions Size | 10,241 chars | 5,237 chars | **-49%** |
| Approx Tokens | ~2,560 | ~1,310 | **-1,250 tokens** |
| Public Tools | 21 | 20 | (hidden `update_task`) |

### Incremental Message Reading (DONE)

- [x] **Read Cursors Table**: `read_cursors` tracks each IDE's last read message ID per meeting
- [x] **Auto-Increment**: `read_messages` automatically returns only unread messages
- [x] **Zero Config**: No `afterId` parameter needed - cursor managed server-side by `instanceId`
- [x] **Response Format**: Returns `{ newMessages: N, messages: [...] }` for easy verification

**Flow**:
```
IDE-A (first call):  read_messages() → returns all messages, sets cursor
IDE-B sends message: "Hello from B"
IDE-A (second call): read_messages() → returns only "Hello from B" (1 new message)
```

### Context7-Style Progressive Loading (DONE)

**`get_global_topology` Optimization:**
- [x] **List Mode (Default)**: Returns summary `{ totalProjects, totalEdges, projects: [{id, name}] }`
- [x] **Focused Mode**: `get_global_topology(projectId)` returns detailed subgraph for that project
- [x] **Token Savings**: AI reads list first, then queries specific project as needed

**`listResources` Optimization:**
- [x] **Static Resources**: Fixed 8 core resources (chat, registry, docs, meetings, etc.)
- [x] **Template-Based Projects**: No longer lists each project dynamically
- [x] **O(1) Scaling**: Resource list size is constant regardless of project count
- [x] **Discovery Flow**: AI reads `registry` → constructs URI from template

| Scenario | Before | After |
|----------|--------|-------|
| 0 projects | 8 resources | 8 resources + 4 templates |
| 20 projects | 28 resources | 8 resources + 4 templates (fixed) |
| 50 projects | 58 resources | 8 resources + 4 templates (fixed) |

---
*Last updated: 2026-01-01 by Antigravity AI.*

