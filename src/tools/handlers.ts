import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";

import { CONFIG } from "../config.js";
import { StorageManager } from "../storage/index.js";
import { UnifiedMeetingStore } from "../storage/store.js";
import {
    createTask, getTask, listTasks, updateTask, cancelTask,
    TaskStatus
} from "../storage/tasks.js";
import { ProjectManifest, DiscussionMessage } from "../types.js";
import { TOOL_REGISTRY } from "./schemas.js";

export interface ToolContext {
    currentProject: string | null;
    setCurrentProject: (id: string) => void;
    notifyResourceUpdate: (uri: string) => void;
}


/**
 * Handles all tool executions
 */
export async function handleToolCall(
    name: string,
    toolArgs: Record<string, unknown>,
    ctx: ToolContext
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    await StorageManager.init();

    // --- Phase 1.5: Schema Validation ---
    const toolEntry = TOOL_REGISTRY[name];
    if (!toolEntry) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let validatedArgs: any;
    try {
        validatedArgs = toolEntry.schema.parse(toolArgs);
    } catch (e: unknown) {
        const error = e as Error;
        throw new McpError(ErrorCode.InvalidParams, `Schema validation failed: ${error.message}`);
    }

    switch (name) {
        case "register_session_context":
            return handleRegisterSession(validatedArgs, ctx);

        case "sync_project_assets":
            return handleSyncProjectAssets(validatedArgs, ctx);

        case "upload_project_asset":
            return handleUploadAsset(validatedArgs, ctx);

        case "get_global_topology":
            return handleGetTopology();

        case "send_message":
            return handleSendMessage(validatedArgs, ctx);

        case "read_messages":
            return handleReadMessages(validatedArgs);

        case "update_global_strategy":
            return handleUpdateStrategy(validatedArgs, ctx);

        case "sync_global_doc":
            return handleSyncGlobalDoc(validatedArgs);

        case "update_project":
            return handleUpdateProject(validatedArgs);

        case "rename_project":
            return handleRenameProject(validatedArgs, ctx);

        case "moderator_delete_project":
            return handleRemoveProject(validatedArgs, ctx);

        case "moderator_maintenance":
            return handleModeratorMaintenance(validatedArgs, ctx);

        // --- Meeting Tools ---
        case "start_meeting":
            return handleStartMeeting(validatedArgs, ctx);

        case "end_meeting":
            return handleEndMeeting(validatedArgs, ctx);

        case "archive_meeting":
            return handleArchiveMeeting(validatedArgs, ctx);

        case "reopen_meeting":
            return handleReopenMeeting(validatedArgs, ctx);

        // --- Phase 2: Task Management ---
        case "create_task":
            return handleCreateTask(validatedArgs);

        case "get_task":
            return handleGetTask(validatedArgs);

        case "list_tasks":
            return handleListTasks(validatedArgs);

        case "update_task":
            return handleUpdateTask(validatedArgs);

        case "cancel_task":
            return handleCancelTask(validatedArgs);

        default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
}

// --- Session Handlers ---

function handleRegisterSession(args: { projectId: string }, ctx: ToolContext) {
    // projectId already validated by Zod schema with refine()
    ctx.setCurrentProject(args.projectId);
    return { content: [{ type: "text", text: `Active Nexus Context: ${args.projectId}` }] };
}

// --- Project Asset Handlers ---

/**
 * ASYNC TRIAL: sync_project_assets now uses the Task primitive for non-blocking operation.
 * Returns a taskId immediately; actual sync happens in background.
 */
async function handleSyncProjectAssets(
    args: { manifest: ProjectManifest; internalDocs: string },
    ctx: ToolContext
) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered. Call register_session_context first.");

    // All field validation is now handled by Zod schema (SyncProjectAssetsSchema)
    const m = args.manifest;

    // Validate localPath exists BEFORE creating task (fail-fast)
    if (!await StorageManager.exists(m.localPath)) {
        throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${m.localPath}'. Please provide a valid directory path.`);
    }

    // Create background task with metadata
    const task = createTask({
        metadata: {
            operation: "sync_project_assets",
            projectId: m.id,
            manifestName: m.name,
            initiator: CONFIG.instanceId
        }
    });

    // Execute sync in background (non-blocking)
    setImmediate(async () => {
        try {
            // Update task to running
            updateTask(task.id, { status: "running", progress: 0.1 });

            // Step 1: Save manifest (40%)
            await StorageManager.saveProjectManifest(m);
            updateTask(task.id, { progress: 0.4 });

            // Step 2: Save docs (70%)
            await StorageManager.saveProjectDocs(ctx.currentProject!, args.internalDocs);
            updateTask(task.id, { progress: 0.7 });

            // Step 3: Log and notify (90%)
            await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}@${ctx.currentProject}] Asset Sync: Full sync of manifest and docs.`);
            updateTask(task.id, { progress: 0.9 });

            // Step 4: Notify resource updates
            ctx.notifyResourceUpdate(`mcp://nexus/projects/${m.id}/manifest`);
            ctx.notifyResourceUpdate(`mcp://nexus/projects/${m.id}/internal-docs`);
            ctx.notifyResourceUpdate("mcp://nexus/hub/registry");
            ctx.notifyResourceUpdate("mcp://nexus/chat/global");

            // Complete
            updateTask(task.id, {
                status: "completed",
                progress: 1.0,
                result_uri: `mcp://nexus/projects/${m.id}/manifest`
            });

        } catch (error) {
            // Mark failed with error message
            updateTask(task.id, {
                status: "failed",
                error_message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Return immediately with task info (non-blocking response)
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Sync task created. Use get_task to poll for completion.",
                task_id: task.id,
                status: "pending",
                poll_hint: "Call get_task with this task_id to check progress."
            }, null, 2)
        }]
    };
}

async function handleUploadAsset(args: { fileName: string; base64Content: string }, ctx: ToolContext) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");
    if (!args?.base64Content || !args?.fileName) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'base64Content' and 'fileName' are required.");
    }
    const buff = Buffer.from(args.base64Content, "base64");
    await StorageManager.saveAsset(ctx.currentProject, args.fileName, buff);
    return { content: [{ type: "text", text: `Asset '${args.fileName}' saved to project '${ctx.currentProject}'.` }] };
}


async function handleUpdateProject(args: { projectId: string; patch: Partial<ProjectManifest> }) {
    if (!args?.projectId || !args?.patch) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'projectId' and 'patch' are required.");
    }
    if (args.patch.id) {
        throw new McpError(ErrorCode.InvalidParams, "Cannot change 'id' via patch. Use 'rename_project' instead.");
    }
    if (args.patch.localPath && !await StorageManager.exists(args.patch.localPath)) {
        throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${args.patch.localPath}'. Please provide a valid directory path.`);
    }
    await StorageManager.patchProjectManifest(args.projectId, args.patch);
    const changedFields = Object.keys(args.patch).join(", ");
    return { content: [{ type: "text", text: `Project '${args.projectId}' updated. Changed fields: ${changedFields}.` }] };
}

/**
 * ASYNC: rename_project now returns a taskId.
 */
async function handleRenameProject(args: { oldId: string; newId: string }, ctx: ToolContext) {
    // Validate project exists before creating task
    const exists = await StorageManager.getProjectManifest(args.oldId);
    if (!exists) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.oldId}' not found.`);

    // Create background task
    const task = createTask({
        metadata: {
            operation: "rename_project",
            oldId: args.oldId,
            newId: args.newId,
            initiator: CONFIG.instanceId
        }
    });

    // Background execution
    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.2 });

            const updatedCount = await StorageManager.renameProject(args.oldId, args.newId);
            updateTask(task.id, { progress: 0.8 });

            // Notify all affected project resources and registry
            ctx.notifyResourceUpdate("mcp://nexus/hub/registry");
            ctx.notifyResourceUpdate(`mcp://nexus/projects/${args.newId}/manifest`);
            ctx.notifyResourceUpdate("mcp://get_global_topology");

            updateTask(task.id, {
                status: "completed",
                progress: 1.0,
                result_uri: `mcp://nexus/projects/${args.newId}/manifest`
            });

            await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Task Completed: Project renamed '${args.oldId}' -> '${args.newId}'. Handled ${updatedCount} cascading updates.`);
        } catch (error) {
            updateTask(task.id, {
                status: "failed",
                error_message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Rename task created.",
                task_id: task.id,
                status: "pending"
            }, null, 2)
        }]
    };
}

// --- Global Handlers ---

async function handleGetTopology() {
    const topo = await StorageManager.calculateTopology();
    return { content: [{ type: "text", text: JSON.stringify(topo, null, 2) }] };
}

async function handleSendMessage(args: { message: string; category?: DiscussionMessage["category"] }, ctx: ToolContext) {
    if (!args?.message) throw new McpError(ErrorCode.InvalidParams, "Message content cannot be empty.");

    const from = `${CONFIG.instanceId}@${ctx.currentProject || "Global"}`;
    const message: DiscussionMessage = {
        timestamp: new Date().toISOString(),
        from,
        text: args.message,
        category: args.category
    };

    // Check for active meeting - auto-route if exists
    const activeMeeting = await UnifiedMeetingStore.getActiveMeeting();

    if (activeMeeting) {
        // Route to active meeting
        await UnifiedMeetingStore.addMessage(activeMeeting.id, message);
        ctx.notifyResourceUpdate(`mcp://nexus/meetings/${activeMeeting.id}`);
        ctx.notifyResourceUpdate("mcp://nexus/chat/global");

        return {
            content: [{
                type: "text",
                text: `Message posted to active meeting '${activeMeeting.topic}' (${activeMeeting.id})${args.category ? ` [${args.category}]` : ""}.`
            }]
        };
    } else {
        // Fallback to global discussion (backward compatibility)
        await StorageManager.addGlobalLog(from, args.message, args.category);
        ctx.notifyResourceUpdate("mcp://nexus/chat/global");

        return {
            content: [{
                type: "text",
                text: `Message broadcasted to Nexus Room (no active meeting)${args.category ? ` [${args.category}]` : ""}.`
            }]
        };
    }
}

async function handleReadMessages(args: { count?: number; meetingId?: string }) {
    const count = args?.count || 10;

    // If meetingId specified, read from that meeting
    if (args?.meetingId) {
        const messages = await UnifiedMeetingStore.getRecentMessages(count, args.meetingId);
        return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }

    // Check for active meeting first
    const activeMeeting = await UnifiedMeetingStore.getActiveMeeting();
    if (activeMeeting) {
        const messages = await UnifiedMeetingStore.getRecentMessages(count, activeMeeting.id);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    source: "meeting",
                    meetingId: activeMeeting.id,
                    topic: activeMeeting.topic,
                    messages
                }, null, 2)
            }]
        };
    }

    // Fallback to global logs
    const logs = await StorageManager.getRecentLogs(count);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                source: "global",
                messages: logs
            }, null, 2)
        }]
    };
}

async function handleUpdateStrategy(args: { content: string }, _ctx: ToolContext) {
    if (!args?.content) throw new McpError(ErrorCode.InvalidParams, "Strategy content cannot be empty.");
    await fs.writeFile(StorageManager.globalBlueprint, args.content);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Updated Coordination Strategy.`);

    // Notify strategy update
    return { content: [{ type: "text", text: "Strategy updated." }] };
}

/**
 * ASYNC: moderator_delete_project now returns a taskId.
 */
async function handleRemoveProject(args: { projectId: string }, ctx: ToolContext) {
    // Defense-in-Depth: Explicit moderator check
    if (!CONFIG.isModerator) {
        throw new McpError(ErrorCode.InvalidRequest, "Permission denied: Only moderators can delete projects.");
    }
    if (!args?.projectId) throw new McpError(ErrorCode.InvalidParams, "projectId is required.");

    // Validate project exists
    const exists = await StorageManager.getProjectManifest(args.projectId);
    if (!exists) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.projectId}' not found.`);

    // Create background task
    const task = createTask({
        metadata: {
            operation: "moderator_delete_project",
            projectId: args.projectId,
            initiator: CONFIG.instanceId
        }
    });

    // Background execution
    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.1 });

            await StorageManager.deleteProject(args.projectId);
            updateTask(task.id, { progress: 0.9 });

            ctx.notifyResourceUpdate("mcp://nexus/hub/registry");
            ctx.notifyResourceUpdate("mcp://nexus/get_global_topology");

            updateTask(task.id, { status: "completed", progress: 1.0 });
            await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Task Completed: Project '${args.projectId}' deleted by moderator.`);
        } catch (error) {
            updateTask(task.id, {
                status: "failed",
                error_message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Delete task created.",
                task_id: task.id,
                status: "pending"
            }, null, 2)
        }]
    };
}

async function handleSyncGlobalDoc(args: { docId: string; title: string; content: string }) {
    if (!args?.docId || !args?.title || !args?.content) {
        throw new McpError(ErrorCode.InvalidParams, "All fields required: docId, title, content.");
    }
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, CONFIG.instanceId);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Synced global doc: ${args.docId}`);
    return { content: [{ type: "text", text: `Global document '${args.docId}' synchronized.` }] };
}


// --- Admin Handlers ---

async function handleModeratorMaintenance(args: { action: "prune" | "clear"; count: number }, ctx: ToolContext) {
    // Defense-in-Depth: Explicit moderator check
    if (!CONFIG.isModerator) {
        throw new McpError(ErrorCode.InvalidRequest, "Permission denied: Only moderators can perform maintenance.");
    }
    if (!args.action || args.count === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'action' and 'count' are mandatory for maintenance.");
    }

    if (args.action === "clear") {
        await StorageManager.clearGlobalLogs();
        ctx.notifyResourceUpdate("mcp://nexus/chat/global");
        return { content: [{ type: "text", text: "History wiped." }] };
    } else {
        try {
            await StorageManager.pruneGlobalLogs(args.count);
            ctx.notifyResourceUpdate("mcp://nexus/chat/global");
            return { content: [{ type: "text", text: `Pruned ${args.count} logs.` }] };
        } catch {
            return { content: [{ type: "text", text: "Prune operation failed due to malformed logs or missing file." }] };
        }
    }
}

// --- Meeting Handlers ---

async function handleStartMeeting(args: { topic: string }, ctx: ToolContext) {
    if (!args?.topic) throw new McpError(ErrorCode.InvalidParams, "Topic is required to start a meeting.");
    const initiator = ctx.currentProject ? `${CONFIG.instanceId}@${ctx.currentProject}` : `${CONFIG.instanceId}@Global`;
    const meeting = await UnifiedMeetingStore.startMeeting(args.topic, initiator);

    // Notify updates
    ctx.notifyResourceUpdate("mcp://nexus/status");
    ctx.notifyResourceUpdate("mcp://nexus/chat/global");

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting started (Topic: '${args.topic}').`,
                meetingId: meeting.id,
                topic: args.topic,
                status: meeting.status,
                startTime: meeting.startTime
            }, null, 2)
        }]
    };
}

async function handleEndMeeting(args: { meetingId?: string; summary?: string }, ctx: ToolContext) {
    let targetId = args.meetingId;
    if (!targetId) {
        const active = await UnifiedMeetingStore.getActiveMeeting();
        if (!active) throw new McpError(ErrorCode.InvalidRequest, "No active meeting found to end. Please specify meetingId.");
        targetId = active.id;
    }
    // STRICT: Only moderators can end meetings
    if (!CONFIG.isModerator) {
        throw new McpError(ErrorCode.InvalidRequest, "Permission denied: Only moderators can end meetings.");
    }

    const { meeting, suggestedSyncTargets } = await UnifiedMeetingStore.endMeeting(targetId, args.summary, undefined);

    ctx.notifyResourceUpdate("mcp://nexus/status");
    ctx.notifyResourceUpdate("mcp://nexus/chat/global");

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting '${meeting.topic}' closed.`,
                meetingId: meeting.id,
                topic: meeting.topic,
                status: meeting.status,
                decisionsCount: meeting.decisions.length,
                suggestedSyncTargets
            }, null, 2)
        }]
    };
}


async function handleArchiveMeeting(args: { meetingId: string }, _ctx: ToolContext) {
    if (!args.meetingId) throw new McpError(ErrorCode.InvalidParams, "meetingId is required.");

    // STRICT: Only moderators can archive meetings
    if (!CONFIG.isModerator) {
        throw new McpError(ErrorCode.InvalidRequest, "Permission denied: Only moderators can archive meetings.");
    }

    await UnifiedMeetingStore.archiveMeeting(args.meetingId, undefined);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting '${args.meetingId}' archived.`,
                meetingId: args.meetingId,
                status: "archived"
            }, null, 2)
        }]
    };
}

async function handleReopenMeeting(args: { meetingId: string }, ctx: ToolContext) {
    if (!args.meetingId) throw new McpError(ErrorCode.InvalidParams, "meetingId is required.");

    const meeting = await UnifiedMeetingStore.reopenMeeting(args.meetingId, undefined);

    ctx.notifyResourceUpdate("mcp://nexus/status");
    ctx.notifyResourceUpdate("mcp://nexus/chat/global");
    ctx.notifyResourceUpdate(`mcp://nexus/meetings/${meeting.id}`);

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting '${meeting.topic}' reopened.`,
                meetingId: meeting.id,
                topic: meeting.topic,
                status: meeting.status
            }, null, 2)
        }]
    };
}

// --- Phase 2: Task Handlers ---
// Note: Tasks table is initialized globally in StorageManager.init()

function handleCreateTask(args: { source_meeting_id?: string; metadata?: Record<string, unknown>; ttl?: number }) {
    const task = createTask({
        source_meeting_id: args.source_meeting_id,
        metadata: args.metadata,
        ttl: args.ttl
    });

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Task created successfully.",
                task_id: task.id,
                status: task.status,
                source_meeting_id: task.source_meeting_id
            }, null, 2)
        }]
    };
}

function handleGetTask(args: { taskId: string }) {
    const task = getTask(args.taskId);
    if (!task) {
        throw new McpError(ErrorCode.InvalidRequest, `Task '${args.taskId}' not found.`);
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify(task, null, 2)
        }]
    };
}

function handleListTasks(args: { status?: TaskStatus; limit?: number }) {
    const tasks = listTasks(args.status, args.limit || 50);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                count: tasks.length,
                tasks: tasks.map(t => ({
                    id: t.id,
                    status: t.status,
                    progress: t.progress,
                    source_meeting_id: t.source_meeting_id,
                    created_at: t.created_at
                }))
            }, null, 2)
        }]
    };
}

function handleUpdateTask(args: { taskId: string; status?: TaskStatus; progress?: number; result_uri?: string; error_message?: string }) {
    const existing = getTask(args.taskId);
    if (!existing) {
        throw new McpError(ErrorCode.InvalidRequest, `Task '${args.taskId}' not found.`);
    }

    const updated = updateTask(args.taskId, {
        status: args.status,
        progress: args.progress,
        result_uri: args.result_uri,
        error_message: args.error_message
    });

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Task updated.",
                task_id: updated!.id,
                status: updated!.status,
                progress: updated!.progress
            }, null, 2)
        }]
    };
}

function handleCancelTask(args: { taskId: string }) {
    const success = cancelTask(args.taskId);
    if (!success) {
        throw new McpError(ErrorCode.InvalidRequest, `Cannot cancel task '${args.taskId}'. Task not found or already completed.`);
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: "Task cancelled.",
                task_id: args.taskId,
                status: "cancelled"
            }, null, 2)
        }]
    };
}
