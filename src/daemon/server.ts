import http from "node:http";
import { URL } from "node:url";

import { StorageManager } from "../storage/index.js";
import { UnifiedMeetingStore } from "../storage/store.js";
import {
    createTask, updateTask, getTask, listTasks, cancelTask,
    initTasksTable, TaskStatus, TaskUpdate
} from "../storage/tasks.js";
import { ProjectManifest, DiscussionMessage } from "../types.js";

// ---------------------------------------------------------------------------
// Storage bootstrap
// ---------------------------------------------------------------------------

export type DaemonStorageInfo = {
    ready: boolean;
    storageMode: "sqlite" | "json";
    isDegraded: boolean;
};

async function initializeStorage(): Promise<DaemonStorageInfo> {
    await StorageManager.init();
    initTasksTable();
    const info = await UnifiedMeetingStore.getStorageInfo();
    return {
        ready: true,
        storageMode: info.storage_mode,
        isDegraded: info.is_degraded
    };
}

// ---------------------------------------------------------------------------
// Per-instance session context (in-memory)
// ---------------------------------------------------------------------------

type SessionCtx = { currentProject: string | null };
const sessions = new Map<string, SessionCtx>();

function getSession(instanceId: string): SessionCtx {
    if (!sessions.has(instanceId)) sessions.set(instanceId, { currentProject: null });
    return sessions.get(instanceId)!;
}

// ---------------------------------------------------------------------------
// Tool definitions  (served via GET /api/tools)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
    // Session
    {
        name: "register_session_context",
        description: "Declare active project. Format: [prefix]_[name] (e.g. 'web_example.com', 'mcp_nexus').",
        inputSchema: {
            type: "object",
            properties: { projectId: { type: "string", description: "Project ID with prefix" } },
            required: ["projectId"]
        }
    },

    // Project assets
    {
        name: "sync_project_assets",
        description: "[ASYNC] Sync full project manifest + internal docs. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: {
                manifest: {
                    type: "object",
                    description: "Project metadata",
                    properties: {
                        id: { type: "string" }, name: { type: "string" },
                        description: { type: "string" },
                        techStack: { type: "array", items: { type: "string" } },
                        relations: { type: "array", items: { type: "object" } },
                        repositoryUrl: { type: "string" }, localPath: { type: "string" },
                        endpoints: { type: "array", items: { type: "object" } },
                        apiSpec: { type: "array", items: { type: "object" } }
                    },
                    required: ["id", "name", "description", "techStack", "relations", "repositoryUrl", "localPath", "endpoints", "apiSpec"]
                },
                internalDocs: { type: "string", description: "Markdown implementation guide" }
            },
            required: ["manifest", "internalDocs"]
        }
    },
    {
        name: "upload_project_asset",
        description: "Upload binary file (base64) to active project's asset folder.",
        inputSchema: {
            type: "object",
            properties: {
                fileName: { type: "string", description: "Safe filename (no path traversal)" },
                base64Content: { type: "string" }
            },
            required: ["fileName", "base64Content"]
        }
    },
    {
        name: "update_project",
        description: "Patch project manifest fields (partial update).",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                patch: { type: "object", description: "Fields to update" }
            },
            required: ["projectId", "patch"]
        }
    },
    {
        name: "rename_project",
        description: "[ASYNC] Rename project ID with cascading relation updates. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: { oldId: { type: "string" }, newId: { type: "string" } },
            required: ["oldId", "newId"]
        }
    },

    // Global collaboration
    {
        name: "search_projects",
        description: "Search project registry by name or description.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                limit: { type: "integer", default: 10 }
            },
            required: ["query"]
        }
    },
    {
        name: "get_global_topology",
        description: "Default: project list + stats. With projectId: detailed subgraph.",
        inputSchema: {
            type: "object",
            properties: { projectId: { type: "string", description: "Focus on specific project (optional)" } }
        }
    },
    {
        name: "send_message",
        description: "Post message to active meeting or global chat.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string" },
                category: { type: "string", enum: ["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT"] }
            },
            required: ["message"]
        }
    },
    {
        name: "read_messages",
        description: "Read unread messages (auto-incremental per instance).",
        inputSchema: {
            type: "object",
            properties: {
                count: { type: "integer", default: 10 },
                meetingId: { type: "string" }
            }
        }
    },
    {
        name: "update_global_strategy",
        description: "Overwrite master strategy document.",
        inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"]
        }
    },
    {
        name: "sync_global_doc",
        description: "Create/update a global shared document.",
        inputSchema: {
            type: "object",
            properties: {
                docId: { type: "string" },
                title: { type: "string" },
                content: { type: "string" }
            },
            required: ["docId", "title", "content"]
        }
    },

    // Meeting management
    {
        name: "start_meeting",
        description: "Start new meeting session. Returns meeting ID.",
        inputSchema: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"]
        }
    },
    {
        name: "end_meeting",
        description: "End active meeting. Locks history.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string" },
                summary: { type: "string" }
            }
        }
    },
    {
        name: "archive_meeting",
        description: "Archive closed meeting. Read-only after.",
        inputSchema: {
            type: "object",
            properties: { meetingId: { type: "string" } },
            required: ["meetingId"]
        }
    },
    {
        name: "reopen_meeting",
        description: "Reopen closed/archived meeting.",
        inputSchema: {
            type: "object",
            properties: { meetingId: { type: "string" } },
            required: ["meetingId"]
        }
    },

    // Task management
    {
        name: "create_task",
        description: "[ASYNC] Create background task. Returns taskId for polling.",
        inputSchema: {
            type: "object",
            properties: {
                source_meeting_id: { type: "string", description: "Link to meeting for traceability" },
                metadata: { type: "object" },
                ttl: { type: "integer", description: "TTL in milliseconds" }
            }
        }
    },
    {
        name: "get_task",
        description: "Get task status and progress by ID.",
        inputSchema: {
            type: "object",
            properties: { taskId: { type: "string" } },
            required: ["taskId"]
        }
    },
    {
        name: "list_tasks",
        description: "List tasks with optional status filter.",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
                limit: { type: "integer", default: 50 }
            }
        }
    },
    {
        name: "cancel_task",
        description: "Cancel pending/running task.",
        inputSchema: {
            type: "object",
            properties: { taskId: { type: "string" } },
            required: ["taskId"]
        }
    },

    // Maintenance
    {
        name: "host_maintenance",
        description: "Manage logs: 'prune' oldest N or 'clear' all.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["prune", "clear"] },
                count: { type: "integer", minimum: 0 }
            },
            required: ["action", "count"]
        }
    },
    {
        name: "host_delete_project",
        description: "[ASYNC] Delete project. Irreversible. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" } },
            required: ["projectId"]
        }
    }
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function toolRegisterSessionContext(args: { projectId: string }, instanceId: string) {
    if (!args.projectId) throw new Error("projectId is required.");
    const manifest = await StorageManager.getProjectManifest(args.projectId);
    if (!manifest) {
        return { ok: false, message: `Project '${args.projectId}' not found in registry.` };
    }
    getSession(instanceId).currentProject = args.projectId;
    await StorageManager.addGlobalLog("SYSTEM", `Session Context set to Project: ${args.projectId} (instance: ${instanceId})`);
    return { ok: true, message: `Session context registered for project: ${args.projectId}.` };
}

async function toolSyncProjectAssets(args: { manifest: ProjectManifest; internalDocs: string }, instanceId: string) {
    const m = args.manifest;
    if (!m?.id) throw new Error("manifest.id is required.");

    const task = createTask({
        metadata: { operation: "sync_project_assets", projectId: m.id, initiator: instanceId }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.1 });
            await StorageManager.saveProjectManifest(m);
            updateTask(task.id, { progress: 0.5 });
            await StorageManager.saveProjectDocs(m.id, args.internalDocs);
            updateTask(task.id, { progress: 0.9 });
            await StorageManager.addGlobalLog("SYSTEM", `[${instanceId}@${m.id}] Asset Sync completed.`);
            updateTask(task.id, { status: "completed", progress: 1.0, result_uri: `nexus://projects/${m.id}/manifest` });
        } catch (e) {
            updateTask(task.id, { status: "failed", error_message: String(e) });
        }
    });

    return { task_id: task.id, status: "pending", message: "Sync task created. Use get_task to poll for completion." };
}

async function toolUploadAsset(args: { fileName: string; base64Content: string }, instanceId: string) {
    const session = getSession(instanceId);
    if (!session.currentProject) throw new Error("No active project. Call register_session_context first.");
    if (!args.fileName || !args.base64Content) throw new Error("fileName and base64Content are required.");
    const sanitized = args.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const buf = Buffer.from(args.base64Content, "base64");
    await StorageManager.saveAsset(session.currentProject, sanitized, buf);
    return { ok: true, message: `Asset '${sanitized}' saved to project '${session.currentProject}'.` };
}

async function toolUpdateProject(args: { projectId: string; patch: Partial<ProjectManifest> }, instanceId: string) {
    if (!args.projectId || !args.patch) throw new Error("projectId and patch are required.");
    if ((args.patch as Record<string, unknown>).id) throw new Error("Cannot change 'id' via patch. Use rename_project instead.");

    const task = createTask({
        metadata: { operation: "update_project", projectId: args.projectId, initiator: instanceId }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.2 });
            await StorageManager.patchProjectManifest(args.projectId, args.patch);
            updateTask(task.id, { status: "completed", progress: 1.0, result_uri: `nexus://projects/${args.projectId}/manifest` });
        } catch (e) {
            updateTask(task.id, { status: "failed", error_message: String(e) });
        }
    });

    return { task_id: task.id, status: "pending", message: "Update task created." };
}

async function toolRenameProject(args: { oldId: string; newId: string }, instanceId: string) {
    if (!args.oldId || !args.newId) throw new Error("oldId and newId are required.");
    const exists = await StorageManager.getProjectManifest(args.oldId);
    if (!exists) throw new Error(`Project '${args.oldId}' not found.`);

    const task = createTask({
        metadata: { operation: "rename_project", oldId: args.oldId, newId: args.newId, initiator: instanceId }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.2 });
            const count = await StorageManager.renameProject(args.oldId, args.newId);
            await StorageManager.addGlobalLog("SYSTEM", `Project renamed '${args.oldId}' → '${args.newId}' (${count} cascading updates).`);
            updateTask(task.id, { status: "completed", progress: 1.0, result_uri: `nexus://projects/${args.newId}/manifest` });
        } catch (e) {
            updateTask(task.id, { status: "failed", error_message: String(e) });
        }
    });

    return { task_id: task.id, status: "pending", message: "Rename task created." };
}

async function toolSearchProjects(args: { query: string; limit?: number }) {
    if (!args.query) throw new Error("query is required.");
    const registry = await StorageManager.listRegistry();
    const projects = registry.projects as Record<string, { name?: string; summary?: string }>;
    const q = args.query.toLowerCase();
    const limit = args.limit || 10;

    const results = Object.entries(projects)
        .filter(([id, p]) =>
            id.toLowerCase().includes(q) ||
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.summary && p.summary.toLowerCase().includes(q))
        )
        .slice(0, limit)
        .map(([id, p]) => ({ id, name: p.name || id, description: p.summary }));

    return { query: args.query, count: results.length, results };
}

async function toolGetGlobalTopology(args: { projectId?: string }) {
    return StorageManager.calculateTopology(args.projectId);
}

async function toolSendMessage(args: { message: string; category?: DiscussionMessage["category"] }, instanceId: string) {
    if (!args.message) throw new Error("message is required.");
    const session = getSession(instanceId);
    const activeMeeting = await UnifiedMeetingStore.getActiveMeeting();
    const meetingId = (activeMeeting && session.currentProject) ? activeMeeting.id : null;

    if (meetingId) {
        const msg: DiscussionMessage = {
            from: instanceId,
            text: args.message,
            category: args.category,
            timestamp: new Date().toISOString()
        };
        await UnifiedMeetingStore.addMessage(meetingId, msg);
        return { ok: true, sentTo: "meeting", meetingId, message: `Message sent to meeting ${meetingId}.` };
    }

    await StorageManager.addGlobalLog(instanceId, args.message, args.category);
    return { ok: true, sentTo: "global", message: "Message sent to global chat." };
}

async function toolReadMessages(args: { count?: number; meetingId?: string }, instanceId: string) {
    const count = args.count || 10;

    if (args.meetingId) {
        const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
        if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
        const messages = await UnifiedMeetingStore.getRecentMessages(count, args.meetingId, instanceId);
        return { source: "meeting", meetingId: args.meetingId, messages, count: messages.length };
    }

    const logs = await StorageManager.getRecentLogs(count);
    return { source: "global", messages: logs, count: logs.length };
}

async function toolUpdateGlobalStrategy(args: { content: string }, instanceId: string) {
    if (!args.content) throw new Error("content is required.");
    await StorageManager.saveGlobalDoc("strategy", "Global Collaboration Strategy", args.content, instanceId);
    return { ok: true, message: "Global strategy updated." };
}

async function toolSyncGlobalDoc(args: { docId: string; title: string; content: string }, instanceId: string) {
    if (!args.docId || !args.title || !args.content) throw new Error("docId, title, and content are required.");
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, instanceId);
    return { ok: true, message: `Global document '${args.title}' (${args.docId}) synchronized.` };
}

async function toolStartMeeting(args: { topic: string }, instanceId: string) {
    if (!args.topic) throw new Error("topic is required.");
    const meeting = await UnifiedMeetingStore.startMeeting(args.topic, instanceId);
    return { ok: true, meetingId: meeting.id, topic: meeting.topic, status: meeting.status };
}

async function toolEndMeeting(args: { meetingId?: string; summary?: string }, instanceId: string) {
    let id = args.meetingId;
    if (!id) {
        const active = await UnifiedMeetingStore.getActiveMeeting();
        if (active) id = active.id;
    }
    if (!id) throw new Error("No active meeting found to end.");

    const result = await UnifiedMeetingStore.endMeeting(id, args.summary, instanceId);
    if (args.summary) {
        await StorageManager.addGlobalLog("SYSTEM", `Meeting ended: ${result.meeting.topic}. Summary: ${args.summary}`);
    }
    return { ok: true, meetingId: id, status: "closed", summary: result.meeting.summary };
}

async function toolArchiveMeeting(args: { meetingId: string }, instanceId: string) {
    const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    await UnifiedMeetingStore.archiveMeeting(args.meetingId, instanceId);
    return { ok: true, meetingId: args.meetingId, status: "archived" };
}

async function toolReopenMeeting(args: { meetingId: string }, instanceId: string) {
    const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    await UnifiedMeetingStore.reopenMeeting(args.meetingId, instanceId);
    return { ok: true, meetingId: args.meetingId, status: "active" };
}

async function toolCreateTask(args: { source_meeting_id?: string; metadata?: Record<string, unknown>; ttl?: number }) {
    const task = createTask({ source_meeting_id: args.source_meeting_id, metadata: args.metadata, ttl: args.ttl });
    return { task_id: task.id, status: task.status, message: "Task created.", task };
}

async function toolGetTask(args: { taskId: string }) {
    const task = getTask(args.taskId);
    if (!task) throw new Error(`Task '${args.taskId}' not found.`);
    return task;
}

async function toolListTasks(args: { status?: TaskStatus; limit?: number }) {
    const tasks = listTasks(args.status, args.limit || 50);
    return { count: tasks.length, tasks };
}

async function toolCancelTask(args: { taskId: string }) {
    const ok = cancelTask(args.taskId);
    if (!ok) throw new Error(`Task '${args.taskId}' not found or cannot be cancelled.`);
    return { ok: true, taskId: args.taskId, message: "Task cancelled." };
}

async function toolHostMaintenance(args: { action: "prune" | "clear"; count: number }) {
    if (args.action === "clear") {
        await StorageManager.clearGlobalLogs();
        return { ok: true, message: "All logs cleared." };
    }
    await StorageManager.pruneGlobalLogs(args.count);
    return { ok: true, message: `Pruned oldest ${args.count} log entries.` };
}

async function toolHostDeleteProject(args: { projectId: string }, instanceId: string) {
    const exists = await StorageManager.getProjectManifest(args.projectId);
    if (!exists) throw new Error(`Project '${args.projectId}' not found.`);

    const task = createTask({
        metadata: { operation: "delete_project", projectId: args.projectId, initiator: instanceId }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.3 });
            await StorageManager.deleteProject(args.projectId);
            await StorageManager.addGlobalLog("SYSTEM", `Project deleted: '${args.projectId}' by ${instanceId}.`);
            updateTask(task.id, { status: "completed", progress: 1.0 });
        } catch (e) {
            updateTask(task.id, { status: "failed", error_message: String(e) });
        }
    });

    return { task_id: task.id, status: "pending", message: "Delete task created." };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(name: string, args: Record<string, unknown>, instanceId: string): Promise<unknown> {
    const u = args as unknown;
    switch (name) {
        case "register_session_context":  return toolRegisterSessionContext(u as { projectId: string }, instanceId);
        case "sync_project_assets":       return toolSyncProjectAssets(u as { manifest: ProjectManifest; internalDocs: string }, instanceId);
        case "upload_project_asset":      return toolUploadAsset(u as { fileName: string; base64Content: string }, instanceId);
        case "update_project":            return toolUpdateProject(u as { projectId: string; patch: Partial<ProjectManifest> }, instanceId);
        case "rename_project":            return toolRenameProject(u as { oldId: string; newId: string }, instanceId);
        case "search_projects":           return toolSearchProjects(u as { query: string; limit?: number });
        case "get_global_topology":       return toolGetGlobalTopology(u as { projectId?: string });
        case "send_message":              return toolSendMessage(u as { message: string; category?: DiscussionMessage["category"] }, instanceId);
        case "read_messages":             return toolReadMessages(u as { count?: number; meetingId?: string }, instanceId);
        case "update_global_strategy":    return toolUpdateGlobalStrategy(u as { content: string }, instanceId);
        case "sync_global_doc":           return toolSyncGlobalDoc(u as { docId: string; title: string; content: string }, instanceId);
        case "start_meeting":             return toolStartMeeting(u as { topic: string }, instanceId);
        case "end_meeting":               return toolEndMeeting(u as { meetingId?: string; summary?: string }, instanceId);
        case "archive_meeting":           return toolArchiveMeeting(u as { meetingId: string }, instanceId);
        case "reopen_meeting":            return toolReopenMeeting(u as { meetingId: string }, instanceId);
        case "create_task":               return toolCreateTask(u as { source_meeting_id?: string; metadata?: Record<string, unknown>; ttl?: number });
        case "get_task":                  return toolGetTask(u as { taskId: string });
        case "list_tasks":                return toolListTasks(u as { status?: TaskStatus; limit?: number });
        case "cancel_task":               return toolCancelTask(u as { taskId: string });
        case "host_maintenance":          return toolHostMaintenance(u as { action: "prune" | "clear"; count: number });
        case "host_delete_project":       return toolHostDeleteProject(u as { projectId: string }, instanceId);
        default:
            throw new Error(`Unknown tool: '${name}'`);
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
}

async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => { data += chunk; });
        req.on("end", () => {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
        });
        req.on("error", reject);
    });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export async function createDaemonServer(options: {
    port: number;
    host?: string;
    version: string;
}): Promise<{ server: http.Server; storageInfo: DaemonStorageInfo }> {
    const storageInfo = await initializeStorage();

    const server = http.createServer(async (req, res) => {
        const method = req.method || "GET";
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        const path = url.pathname;

        try {
            // Health
            if (method === "GET" && path === "/health") {
                return jsonResponse(res, 200, {
                    ok: true, version: options.version,
                    storageMode: storageInfo.storageMode,
                    isDegraded: storageInfo.isDegraded,
                    ready: storageInfo.ready
                });
            }

            // Storage info
            if (method === "GET" && path === "/api/storage/info") {
                return jsonResponse(res, 200, storageInfo);
            }

            // Tool definitions
            if (method === "GET" && path === "/api/tools") {
                return jsonResponse(res, 200, { tools: TOOL_DEFINITIONS });
            }

            // Tool call dispatcher  ← core endpoint
            if (method === "POST" && path === "/api/tools/call") {
                const body = await parseBody(req);
                const toolName = body.tool as string;
                const args = (body.args || {}) as Record<string, unknown>;
                const instanceId = (body.instanceId as string) || "unknown";

                if (!toolName) return jsonResponse(res, 400, { ok: false, error: "tool is required" });

                const result = await dispatchTool(toolName, args, instanceId);
                return jsonResponse(res, 200, { ok: true, result });
            }

            // Messages
            if (method === "POST" && path === "/api/messages/send") {
                const body = await parseBody(req);
                if (!body.message) return jsonResponse(res, 400, { ok: false, error: "message is required" });
                const instanceId = (body.instanceId as string) || "unknown";
                const meetingId = body.meetingId as string | undefined;
                const source = body.source as string | undefined;

                // Direct meetingId routing (bypasses session currentProject check)
                if (meetingId || source === "meeting") {
                    const targetMeetingId = meetingId || (await UnifiedMeetingStore.getActiveMeeting())?.id || null;
                    if (!targetMeetingId) {
                        return jsonResponse(res, 200, { ok: false, sentTo: "global", message: "No active meeting found." });
                    }
                    const msg: DiscussionMessage = {
                        from: instanceId, text: body.message as string,
                        category: (body.category as DiscussionMessage["category"]) || "CHAT",
                        timestamp: new Date().toISOString()
                    };
                    await UnifiedMeetingStore.addMessage(targetMeetingId, msg);
                    return jsonResponse(res, 200, { ok: true, sentTo: "meeting", meetingId: targetMeetingId, message: `Message sent to meeting ${targetMeetingId}.` });
                }

                const result = await toolSendMessage(
                    { message: body.message as string, category: body.category as DiscussionMessage["category"] },
                    instanceId
                );
                return jsonResponse(res, 200, result);
            }

            if (method === "GET" && path === "/api/messages/unread") {
                const count = Number(url.searchParams.get("count")) || 10;
                const meetingId = url.searchParams.get("meetingId") || undefined;
                const instanceId = url.searchParams.get("instanceId") || "unknown";
                const result = await toolReadMessages({ count, meetingId }, instanceId);
                return jsonResponse(res, 200, result);
            }

            // Projects
            if (method === "POST" && path === "/api/projects/sync") {
                const body = await parseBody(req);
                if (!body.manifest) return jsonResponse(res, 400, { ok: false, error: "manifest is required" });
                const result = await toolSyncProjectAssets(
                    { manifest: body.manifest as ProjectManifest, internalDocs: (body.internalDocs as string) || "" },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, 200, { ok: true, ...result });
            }

            if (method === "POST" && path === "/api/projects/update") {
                const body = await parseBody(req);
                if (!body.projectId || !body.patch) return jsonResponse(res, 400, { ok: false, error: "projectId and patch are required" });
                const result = await toolUpdateProject(
                    { projectId: body.projectId as string, patch: body.patch as Partial<ProjectManifest> },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, 200, { ok: true, ...result });
            }

            if (method === "POST" && path === "/api/projects/rename") {
                const body = await parseBody(req);
                if (!body.oldId || !body.newId) return jsonResponse(res, 400, { ok: false, error: "oldId and newId are required" });
                const result = await toolRenameProject(
                    { oldId: body.oldId as string, newId: body.newId as string },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, 200, { ok: true, ...result });
            }

            if (method === "POST" && path === "/api/projects/delete") {
                const body = await parseBody(req);
                if (!body.projectId) return jsonResponse(res, 400, { ok: false, error: "projectId is required" });
                const result = await toolHostDeleteProject(
                    { projectId: body.projectId as string },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, 200, { ok: true, ...result });
            }

            if (method === "GET" && path === "/api/projects/search") {
                const query = url.searchParams.get("query") || "";
                const limit = Number(url.searchParams.get("limit")) || 10;
                if (!query) return jsonResponse(res, 400, { ok: false, error: "query is required" });
                const result = await toolSearchProjects({ query, limit });
                return jsonResponse(res, 200, result);
            }

            if (method === "GET" && path === "/api/projects/topology") {
                const projectId = url.searchParams.get("projectId") || undefined;
                const result = await toolGetGlobalTopology({ projectId });
                return jsonResponse(res, 200, result);
            }

            // Session
            if (method === "POST" && path === "/api/session/register") {
                const body = await parseBody(req);
                if (!body.projectId) return jsonResponse(res, 400, { ok: false, error: "projectId is required" });
                const result = await toolRegisterSessionContext(
                    { projectId: body.projectId as string },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, result.ok ? 200 : 404, result);
            }

            // Global docs
            if (method === "GET" && path === "/api/global/docs") {
                const index = await StorageManager.listGlobalDocs();
                return jsonResponse(res, 200, { docs: index });
            }

            const docMatch = path.match(/^\/api\/global\/docs\/(.+)$/);
            if (docMatch) {
                const docId = decodeURIComponent(docMatch[1]);
                if (method === "GET") {
                    const doc = await StorageManager.getGlobalDoc(docId);
                    if (!doc) return jsonResponse(res, 404, { ok: false, error: `Document '${docId}' not found.` });
                    return jsonResponse(res, 200, doc);
                }
                if (method === "POST") {
                    const body = await parseBody(req);
                    if (!body.title || !body.content) return jsonResponse(res, 400, { ok: false, error: "title and content are required" });
                    const instanceId = (body.instanceId as string) || "unknown";
                    await StorageManager.saveGlobalDoc(docId, body.title as string, body.content as string, instanceId);
                    return jsonResponse(res, 200, { ok: true, docId });
                }
            }

            if (method === "POST" && path === "/api/global/strategy") {
                const body = await parseBody(req);
                if (!body.content) return jsonResponse(res, 400, { ok: false, error: "content is required" });
                const instanceId = (body.instanceId as string) || "unknown";
                const result = await toolUpdateGlobalStrategy({ content: body.content as string }, instanceId);
                return jsonResponse(res, 200, result);
            }

            // Meetings
            if (method === "POST" && path === "/api/meetings/start") {
                const body = await parseBody(req);
                if (!body.topic) return jsonResponse(res, 400, { ok: false, error: "topic is required" });
                const result = await toolStartMeeting({ topic: body.topic as string }, (body.instanceId as string) || "unknown");
                return jsonResponse(res, 200, result);
            }

            if (method === "POST" && path === "/api/meetings/end") {
                const body = await parseBody(req);
                const result = await toolEndMeeting(
                    { meetingId: body.meetingId as string, summary: body.summary as string },
                    (body.instanceId as string) || "unknown"
                );
                return jsonResponse(res, 200, result);
            }

            if (method === "POST" && path === "/api/meetings/archive") {
                const body = await parseBody(req);
                if (!body.meetingId) return jsonResponse(res, 400, { ok: false, error: "meetingId is required" });
                const result = await toolArchiveMeeting({ meetingId: body.meetingId as string }, (body.instanceId as string) || "unknown");
                return jsonResponse(res, 200, result);
            }

            if (method === "POST" && path === "/api/meetings/reopen") {
                const body = await parseBody(req);
                if (!body.meetingId) return jsonResponse(res, 400, { ok: false, error: "meetingId is required" });
                const result = await toolReopenMeeting({ meetingId: body.meetingId as string }, (body.instanceId as string) || "unknown");
                return jsonResponse(res, 200, result);
            }

            const meetingMatch = path.match(/^\/api\/meetings\/(.+)$/);
            if (meetingMatch && method === "GET") {
                const meetingId = decodeURIComponent(meetingMatch[1]);
                const meeting = await UnifiedMeetingStore.getMeeting(meetingId);
                if (!meeting) return jsonResponse(res, 404, { ok: false, error: `Meeting '${meetingId}' not found.` });
                return jsonResponse(res, 200, meeting);
            }

            // Tasks
            if (method === "POST" && path === "/api/tasks") {
                const body = await parseBody(req);
                const result = await toolCreateTask(body as unknown as { source_meeting_id?: string; metadata?: Record<string, unknown>; ttl?: number });
                return jsonResponse(res, 200, result);
            }

            if (method === "GET" && path === "/api/tasks") {
                const status = url.searchParams.get("status") as TaskStatus | null;
                const limit = Number(url.searchParams.get("limit")) || 50;
                const result = await toolListTasks({ status: status || undefined, limit });
                return jsonResponse(res, 200, result);
            }

            const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/(.+))?$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);
                const action = taskMatch[3];

                if (method === "GET" && !action) {
                    const result = await toolGetTask({ taskId });
                    return jsonResponse(res, 200, result);
                }
                if (method === "POST" && action === "update") {
                    const body = await parseBody(req);
                    const task = getTask(taskId);
                    if (!task) return jsonResponse(res, 404, { ok: false, error: `Task '${taskId}' not found.` });
                    const updated = updateTask(taskId, body as unknown as TaskUpdate);
                    return jsonResponse(res, 200, { ok: true, task: updated });
                }
                if (method === "POST" && action === "cancel") {
                    const result = await toolCancelTask({ taskId });
                    return jsonResponse(res, 200, result);
                }
            }

            // Maintenance
            if (method === "POST" && path === "/api/maintenance/logs") {
                const body = await parseBody(req);
                if (!body.action) return jsonResponse(res, 400, { ok: false, error: "action is required" });
                const result = await toolHostMaintenance({ action: body.action as "prune" | "clear", count: (body.count as number) || 0 });
                return jsonResponse(res, 200, result);
            }

            jsonResponse(res, 404, { ok: false, error: "Not found" });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error("[n2n-nexus daemon] Error:", message);
            jsonResponse(res, 500, { ok: false, error: message });
        }
    });

    return { server, storageInfo };
}
