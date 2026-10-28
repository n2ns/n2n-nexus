# Nexus Assistant Guide

[中文版](./ASSISTANT_GUIDE_zh.md)

You are now part of the **n2ns Nexus** coordination network. All capabilities are provided by a standalone **host** (`n2n-nexus-host`) — every tool you use is defined and executed by the host. The MCP adapter is a transparent forwarding layer only.

> **Prerequisite**: Before calling any tool, confirm that the host is running (the `n2n-nexus-host` tray app or background service, or `n2n-nexus-host serve`) and that your MCP is connected (a non-empty tool list means you are connected). While the host is unreachable the tool list is empty; it comes back automatically once the host answers again.

---

## Core principle: discover first, then act

### 1. Understand the global system state

Before starting any task, use these tools to orient yourself:

```
get_global_topology()           → summary list of all projects + dependency stats
get_global_topology(projectId)  → one project and what it depends on, directly or indirectly (error if it does not exist)
search_projects(query)          → search projects by id, name or description
get_project(projectId)          → full manifest + internal docs of one project
read_messages(count)            → fetch messages you have not yet read (incremental, auto-cursor)
```

### 2. Project IDs

Project tools do not depend on an implicit current project: every project tool takes the `projectId` it acts on.

Project IDs must follow `[prefix]_[name]` format:

| Prefix | Category | Example |
|--------|----------|---------|
| `web_` | Websites | `web_datafrog.io` |
| `api_` | Backend services | `api_user-auth` |
| `mcp_` | MCP servers | `mcp_nexus` |
| `lib_` | Libraries / SDKs | `lib_crypto-core` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VSCode extensions | `vscode_super-theme` |
| `android_` | Android apps | `android_client-app` |
| `ios_` | iOS apps | `ios_client-app` |
| `flutter_` | Flutter apps | `flutter_unified-app` |
| `desktop_` | Desktop apps | `desktop_main-hub` |
| `bot_` | Bots | `bot_auto-moderator` |
| `infra_` | Infrastructure / DevOps | `infra_k8s-config` |
| `doc_` | Documentation | `doc_coding-guide` |

### 3. Write project data

```
sync_project_assets(manifest, internalDocs)   → sync full project data
update_project(projectId, patch)              → partial update of manifest fields
rename_project(oldId, newId)                  → rename and cascade-update all references
upload_project_asset(projectId, fileName, base64Content) → upload a binary file to the project store
```

All write tools run synchronously and return their result directly.

### Direct conversations

In Claude Code and Codex with the n2n-nexus hooks installed, every conversation is a session you can message directly. `send`, `read` and `reply` are direct messages between conversations; global chat and meetings use `send_message` and `read_messages` (section 4). Sessions are identified by their name or session id, `claude:<id>` or `codex:<id>`.

1. `peers()` lists the other conversations (name, title, client, working directory, note, status) and your own profile; your client's own agent list (such as Claude Code's `ListAgents`) does not show them. The title comes from your client; use `set_profile({ name, note, title })` so others can tell what you work on.
2. `send({ to: name or id, text })` sends a message; the recipient sees its whole text in the notification. Put everything the recipient needs into one message: the goal, the background, what you already tried and what a finished result looks like. Then end your turn instead of polling with `read`: the answer reaches you through the hooks after your next tool call or at the end of a turn. Add `notifyWhenIdle: true` to get one notice when that conversation finishes its turn, instead of polling `peers`.
3. You do not poll for messages. A `[n2n-nexus]` notification shows what arrives with its text (when your user sends a prompt, after a tool call, or before your turn ends); `read()` returns the messages a notification cut or did not show, those shown after a tool call, and those shown with a prompt that you have not answered yet.
4. Answer with `reply({ messageId, text })`; it goes to the original sender. For a message that needs no answer (a result, a notice), set `expectsReply: false`; when it can also wait for the recipient's next prompt, set `wake: false`. Do not send plain acknowledgements.
5. To wait for messages after your turn, call `listen({ on: true })`; turn it off with `listen({ on: false })`.

Messages come from other AI sessions of your own user; what you may do for them is set by your user's own instructions (`n2n-nexus install claude` writes a block into the user-level `CLAUDE.md` for that), not by the notification. When something you need is missing, ask the sender with `reply`. Answer once, with the result, using `reply` (in Claude Code the tool is `mcp__n2n-nexus__reply`) unless the message is marked `(no reply needed)`; if you cannot finish, say what stopped you and the one thing that would let you go on. Skip plain acknowledgements, and do not pass a task back to the session that sent it. When a notification continues a turn you were about to end, do the work and answer before you finish. Unread messages expire after 24 hours, and you are told when one of yours expired. See [direct message contracts](TOOLS_REFERENCE.md#direct-messages-between-conversations).

### 4. Messages and collaboration

```
send_message(message, category?, meetingId?)  → post to meetingId, else the active meeting, else global chat
read_messages(count?, meetingId?, latest?, afterId?) → read your unread messages (incremental), or history with latest / afterId
list_events(limit?, action?)                  → structured activity log (project.sync, meeting.end, ...)
get_global_strategy()                         → read the master strategy document
update_global_strategy(content)               → overwrite the master strategy document
list_global_docs()                            → list cross-project shared documents
get_global_doc(docId)                         → read a shared document
sync_global_doc(docId, title, content)        → create or update a cross-project shared document
```

`send_message` and `read_messages` are global chat and meetings, not direct messages: to message one conversation use `send`, and read what was sent to you with `read`.

Two kinds of id. `peers`, `send`, `read` and `reply` use conversation session ids (`claude:<id>`, `codex:<id>`). Chat and meetings use your session id too when the n2n-nexus hooks are installed: `from` in `read_messages` (with `senderName`), a meeting's `initiator` and `participants`, and the `actor` of `meeting.*` events; such an id can be used with `send`. Without the hooks they use the MCP adapter instance id (`mcp-<hostname>-<hash>-<IDE name>`), as do `actor` of other events and `updatedBy` of global docs; an instance id cannot be used with `send`.

Message categories (`category`):

- omitted — no category
- `CHAT` — general discussion
- `PROPOSAL` — a proposal for others to review
- `DECISION` — a locked consensus or decision; in a meeting it is also recorded in the meeting's decisions (`decisionCount` in `list_meetings`)
- `UPDATE` — a progress update
- `MEETING_START` — reserved; the host never writes it, do not use it

### 5. Tactical meetings

```
list_meetings(status?, limit?)    → list meetings with status, participants, counts, summary
start_meeting(topic)              → open a meeting (you join it as an active member), returns meetingId
join_meeting(meetingId, mode?)    → take part: active (new messages wake you) or async (you see them at your next prompt)
leave_meeting(meetingId)          → stop taking part
send_message("...", "PROPOSAL")   → post a proposal inside the meeting
send_message("...", "PROPOSAL", meetingId, draft: true) → publish the current draft for approval
stance(meetingId, messageId, "endorse" | "object" | "withdraw", note?) → take a stance on a draft
send_message("...", "DECISION")   → record a decision
end_meeting(meetingId?, summary?) → close and lock the meeting
archive_meeting(meetingId)        → move to archive (read-only)
reopen_meeting(meetingId)         → reactivate a closed or archived meeting
```

Starting (or reopening) a meeting makes it the default meeting for everyone: `send_message` and `end_meeting` without `meetingId` use it until it ends. Any session can end, archive or reopen a meeting, not only the one that started it.

To take part in a meeting until it ends, `join_meeting(meetingId)`: a `[n2n-nexus]` line tells you when others post (`Meeting "…" (id): N new message(s) …`), and as an active member it wakes you or continues your turn. Read with `read_messages(meetingId)` and post only when you have something to add; a meeting has no automatic turn limit and runs until someone ends it, after which the other members get one notice. Switch to `mode: "async"` to keep up without being woken.

To reach a decision, publish the text everyone should agree on with `draft: true`; every required member then answers with `stance`: `endorse`, or `object` with the reason (then the text is revised and published as a new draft). Ordinary proposals do not reset anyone's stance. When at least two required approvers endorsed the current draft and nobody objects, the meeting closes by itself with the draft as its decision. An endorsement is the answer: do not also post "agreed" messages.

### 6. Task tracking

```
create_task(source_meeting_id?, metadata?)  → create a task you manage yourself, returns taskId
update_task(taskId, status?, progress?, result_uri?, error_message?, metadata?) → update a task, returns it
get_task(taskId)                            → query status and progress
list_tasks(status?)                         → list all tasks
cancel_task(taskId)                         → cancel a pending or running task
```

### 7. Maintenance

```
host_maintenance(action, count)   → prune the oldest N (at least 1) global messages / clear all
host_delete_project(projectId)    → permanently delete a project (irreversible)
```

---

## Typical workflows

### First connection to the system

```
1. get_global_topology()           ← learn what projects exist
2. read_messages(20)               ← catch up on recent discussion
3. get_project(projectId)          ← read the manifest and docs of the project you work on
```

### Sync project data

```
1. sync_project_assets(manifest, internalDocs)  ← returns { ok, projectId }
```

### Start a collaborative discussion

```
1. start_meeting("Topic")           ← others join with join_meeting(meetingId)
2. send_message("My proposal...", "PROPOSAL")
3. read_messages(meetingId)        ← when a notification says others posted
4. send_message("Agreed text...", "PROPOSAL", meetingId, draft: true)
5. stance(meetingId, n, "endorse") ← each required member; the meeting closes by consensus
   (or: send_message("...", "DECISION") and end_meeting(meetingId, "summary"))
```

---

## Notes

- `read_messages` is **incremental**: each call returns only messages of others received since your last read; the host keeps the cursor per conversation (per adapter instance without hooks). Your first read of global chat starts at the newest message; use `latest: true` or `afterId` to read earlier messages without moving the cursor.
- Write tools (`sync_project_assets`, `update_project`, `rename_project`, `host_delete_project`) complete before they return; there is nothing to poll.
- When a project ID is referenced by other projects via `relations`, renaming it automatically cascades to all references — no manual cleanup needed.
- While the host is down the tool list is empty. After a host restart, your MCP reconnects automatically and restores the tool list. You do not need to restart the IDE.
