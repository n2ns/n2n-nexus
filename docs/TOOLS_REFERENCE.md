# n2n-nexus tools reference

This document describes the MCP tools exposed by the n2n-nexus adapter. Tool calls are forwarded to the daemon running at `NEXUS_ENDPOINT`.

Parameter tables below are derived from `src/daemon/server.ts` (`TOOL_DEFINITIONS`) and the corresponding tool handlers.

## Conventions

- Project IDs should follow `[prefix]_[name]`, for example `web_example.com`, `api_user-auth`, or `mcp_nexus`.
- Tools marked **async** return a `task_id` immediately. Use `get_task` to poll status and progress.
- `upload_project_asset` requires an active session project. Call `register_session_context` first.
- `host_delete_project` is destructive and irreversible.

## Shared object shapes

### Project manifest

Used by `sync_project_assets` and partially by `update_project`.

| Field | Type | Required by MCP schema | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Project ID. Cannot be changed through `update_project`; use `rename_project`. |
| `name` | string | yes | Human-readable project name. |
| `description` | string | yes | Project summary. |
| `techStack` | string[] | yes | Technologies used by the project. |
| `relations` | object[] | yes | Project relationships. TypeScript shape is `{ targetId, type }`, where `type` is `dependency`, `parent`, `child`, or `related`. |
| `repositoryUrl` | string | yes | Source repository URL. |
| `localPath` | string | yes | Local filesystem path for the project. |
| `endpoints` | object[] | yes | TypeScript shape is `{ name, url, description }`. |
| `apiSpec` | object[] | yes | TypeScript shape is `{ method, path, summary }`. |
| `billing` | object | no | Optional TypeScript field: `{ plain, price }`. |
| `lastUpdated` | string | no | Stored manifest field. |
| `apiDependencies` | object | no | Optional map of project ID to version constraint. |
| `gatewayCompatibility` | string | no | Optional gateway version compatibility string. |
| `api_versions` | object | no | Optional feature-level API version map. |
| `feature_tier` | string | no | Optional `standard`, `advanced`, or `team`. |

## Session and context

### `register_session_context`

Declare the active project for this adapter instance.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Project ID with prefix. The project must already exist in the registry. |

Behavior:

- Sets in-memory session context for the current adapter instance.
- Returns `{ ok: false }` if the project is not found.

## Project asset management

### `sync_project_assets` async

Sync a full project manifest and internal docs.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `manifest` | Project manifest | yes | Full manifest object. See [Project manifest](#project-manifest). |
| `internalDocs` | string | yes | Markdown implementation guide or internal notes. |

Behavior:

- Saves the manifest and project docs.
- Returns `{ task_id, status: "pending" }`.
- Poll with `get_task`.

### `upload_project_asset`

Upload a binary or text asset into the active project's asset store.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `fileName` | string | yes | Filename only. Unsafe path characters are replaced. |
| `base64Content` | string | yes | Base64-encoded file content. |

Behavior:

- Requires `register_session_context` first.
- Saves to the current project's assets directory.

### `update_project` async

Patch fields on an existing project manifest.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Project to update. |
| `patch` | object | yes | Partial manifest fields to update. Must not include `id`. |

Behavior:

- Returns `{ task_id, status: "pending" }`.
- Poll with `get_task`.
- To change a project ID, use `rename_project`.

### `rename_project` async

Rename a project ID and cascade relation updates.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `oldId` | string | yes | Existing project ID. |
| `newId` | string | yes | New project ID. |

Behavior:

- Fails if `oldId` does not exist.
- Returns `{ task_id, status: "pending" }`.
- Poll with `get_task`.

### `search_projects`

Search the project registry.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `query` | string | yes |  | Matches project ID, name, or summary. |
| `limit` | integer | no | `10` | Maximum number of returned projects. |

### `get_global_topology`

Read the project topology.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | no | When provided, returns a focused subgraph for that project. Without it, returns a global project list and stats. |

## Messaging and collaboration

### `send_message`

Post a message to the active meeting or global chat.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `message` | string | yes | Message body. |
| `category` | string | no | One of `MEETING_START`, `PROPOSAL`, `DECISION`, `UPDATE`, or `CHAT`. |

Behavior:

- If there is an active meeting and this adapter has an active project context, the message is sent to the meeting.
- Otherwise it is written to the global chat log.

### `read_messages`

Read recent or unread messages.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `count` | integer | no | `10` | Number of messages to read. |
| `meetingId` | string | no |  | When provided, reads from that meeting. Otherwise reads from global logs. |

Behavior:

- Meeting reads are incremental per adapter instance.
- Global reads return recent global logs.

### `update_global_strategy`

Overwrite the master strategy document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `content` | string | yes | Full Markdown content for the global strategy document. |

### `sync_global_doc`

Create or update a shared global document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `docId` | string | yes | Stable document ID. |
| `title` | string | yes | Human-readable document title. |
| `content` | string | yes | Markdown content. |

## Meeting management

### `start_meeting`

Open a new meeting session.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `topic` | string | yes | Meeting topic. Used to create the meeting record. |

### `end_meeting`

Close and lock a meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | no | Meeting to close. If omitted, the active meeting is used. |
| `summary` | string | no | Optional closing summary. |

### `archive_meeting`

Archive a closed meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | yes | Meeting to archive. |

### `reopen_meeting`

Reactivate a closed or archived meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | yes | Meeting to reopen. |

## Async task management

### `create_task` async

Create a background task.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `source_meeting_id` | string | no | Link the task to a meeting for traceability. |
| `metadata` | object | no | Arbitrary metadata object. |
| `ttl` | integer | no | Time to live in milliseconds. |

Behavior:

- Returns `{ task_id, status, message, task }`.

### `get_task`

Read task status and result.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `taskId` | string | yes | Task ID returned by an async operation. |

### `list_tasks`

List tasks, optionally filtered by status.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `status` | string | no |  | One of `pending`, `running`, `completed`, `failed`, or `cancelled`. |
| `limit` | integer | no | `50` | Maximum number of tasks returned. |

### `cancel_task`

Cancel a pending or running task.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `taskId` | string | yes | Task to cancel. |

## Maintenance

### `host_maintenance`

Prune or clear global logs.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `action` | string | yes | `prune` or `clear`. |
| `count` | integer | yes | Required by the MCP schema. Used by `prune`; ignored by `clear`. |

### `host_delete_project` async

Permanently delete a project and its assets.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Project to delete. |

Behavior:

- Fails if the project does not exist.
- Returns `{ task_id, status: "pending" }`.
- Poll with `get_task`.
- This operation is irreversible.
