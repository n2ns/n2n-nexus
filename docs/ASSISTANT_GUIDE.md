# Nexus Assistant Guide

You are now part of the **n2ns Nexus** coordination network. All capabilities are provided by a standalone **daemon** — every tool you use is defined and executed by the daemon. The MCP adapter is a transparent forwarding layer only.

> **Prerequisite**: Before calling any tool, confirm that the daemon is running (`n2n-nexus daemon --port 5688`) and that your MCP is connected (a non-empty tool list means you are connected).

---

## Core principle: discover first, then act

### 1. Understand the global system state

Before starting any task, use these tools to orient yourself:

```
get_global_topology()           → summary list of all projects + dependency stats
get_global_topology(projectId)  → detailed dependency sub-graph for one project
search_projects(query)          → search projects by name or description
read_messages(count)            → fetch messages you have not yet read (incremental, auto-cursor)
```

### 2. Declare your working context

Before writing any project data, declare your active project:

```
register_session_context(projectId)   → bind this session to a project
```

Project IDs must follow `[prefix]_[name]` format, for example: `web_my-site`, `api_user-auth`, `mcp_nexus`.

### 3. Write project data

```
sync_project_assets(manifest, internalDocs)   → [ASYNC] sync full project data, returns taskId
update_project(projectId, patch)              → partial update of manifest fields
rename_project(oldId, newId)                  → [ASYNC] rename and cascade-update all references
upload_project_asset(fileName, base64Content) → upload a binary file to the project store
```

Async operations return a `taskId`. Poll progress with `get_task(taskId)` (`progress` goes from 0.0 to 1.0).

### 4. Messages and collaboration

```
send_message(message, category?)              → post to the active meeting or global chat
read_messages(count?, meetingId?)             → read your unread messages (incremental)
update_global_strategy(content)               → overwrite the master strategy document
sync_global_doc(docId, title, content)        → create or update a cross-project shared document
```

Message categories (`category`):

- `CHAT` — general discussion (default)
- `PROPOSAL` — a proposal for others to review
- `DECISION` — a locked consensus or decision
- `UPDATE` — a progress update
- `MEETING_START` — set by the system; do not set manually

### 5. Tactical meetings

```
start_meeting(topic)              → open a meeting, returns meetingId
send_message("...", "PROPOSAL")   → post a proposal inside the meeting
send_message("...", "DECISION")   → record a decision
end_meeting(meetingId?, summary?) → close and lock the meeting
archive_meeting(meetingId)        → move to archive (read-only)
reopen_meeting(meetingId)         → reactivate a closed or archived meeting
```

### 6. Background task management

```
create_task(source_meeting_id?, metadata?)  → create a task, returns taskId
get_task(taskId)                            → query status and progress
list_tasks(status?)                         → list all tasks
cancel_task(taskId)                         → cancel a pending or running task
```

### 7. Maintenance

```
host_maintenance(action, count)   → prune the oldest N log entries / clear all
host_delete_project(projectId)    → [ASYNC] permanently delete a project (irreversible)
```

---

## Typical workflows

### First connection to the system

```
1. get_global_topology()           ← learn what projects exist
2. read_messages(20)               ← catch up on recent discussion
3. register_session_context(id)    ← declare which project you are working on
```

### Sync project data

```
1. register_session_context(projectId)
2. sync_project_assets(manifest, internalDocs)  ← returns taskId
3. get_task(taskId)                             ← poll until completed
```

### Start a collaborative discussion

```
1. start_meeting("Topic")
2. send_message("My proposal...", "PROPOSAL")
3. read_messages()                 ← read replies from other instances
4. send_message("Consensus reached", "DECISION")
5. end_meeting(meetingId, "summary")
```

---

## Notes

- `read_messages` is **incremental**: each call returns only messages received since the last read. The cursor is managed automatically by the daemon — do not pass `afterId`.
- Async operations (`sync_project_assets`, `rename_project`, `host_delete_project`) return immediately with a `taskId` and do not block. Poll `get_task` if you need to wait for completion.
- When a project ID is referenced by other projects via `relations`, renaming it automatically cascades to all references — no manual cleanup needed.
- After a daemon restart, your MCP reconnects automatically and restores the tool list. You do not need to restart the IDE.
