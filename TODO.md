# Nexus Project TODO List

## 📅 2025-12-31: Token Economy & API Surface Optimization

**Objective**: Reduce the static Token cost of the MCP server by migrating "Read" operations from Tools to Resources.

### 1. Tool to Resource Migration (Phase 1)
- [ ] **Standardize Resource URIs**: 
    - Ensure `mcp://nexus/meetings/list` and `mcp://nexus/docs/list` are implemented and return structured data.
    - Ensure all dynamic resources (projects, specific meetings, docs) support direct URI reading.
- [ ] **Deprecate Redundant Tools**:
    - [ ] `list_projects` (Use `mcp://nexus/hub/registry`)
    - [ ] `list_meetings` (Use `mcp://nexus/meetings/list`)
    - [ ] `list_global_docs` (Use `mcp://nexus/docs/list`)
    - [ ] `read_project` (Use `mcp://nexus/projects/{id}/manifest`)
    - [ ] `read_global_doc` (Use `mcp://nexus/docs/{id}`)
    - [ ] `read_meeting` (Use `mcp://nexus/meetings/{id}`)
    - [ ] `read_messages` (Use `mcp://nexus/active-meeting`)

### 2. Implementation Strategy
- [ ] **Update `definitions.ts`**: Add `[DEPRECATED: Use Resource]` marker to the descriptions of the above tools to guide AI away from them without breaking backward compatibility immediately.
- [ ] **Internal Refactor**: Ensure the underlying storage methods are optimized for resource-based lazy loading.
- [ ] **Assistant Guide Sync**: Update `ASSISTANT_GUIDE.md` to prioritize Resource-first discovery.

---
*Created on 2025-12-30 by Nexus AI Assistant.*
