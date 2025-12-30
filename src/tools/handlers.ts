import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";

import { CONFIG } from "../config.js";
import { StorageManager } from "../storage/index.js";
import { UnifiedMeetingStore } from "../storage/store.js";
import { ProjectManifest, DiscussionMessage, MeetingSession } from "../types.js";

export interface ToolContext {
    currentProject: string | null;
    setCurrentProject: (id: string) => void;
    notifyResourceUpdate: (uri: string) => void;
}

/**
 * Validation helper for Project IDs.
 */
function validateProjectId(id: string) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Project ID cannot be empty.");

    const validPrefixes = ["web_", "api_", "chrome_", "vscode_", "mcp_", "android_", "ios_", "flutter_", "desktop_", "lib_", "bot_", "infra_", "doc_"];
    const hasPrefix = validPrefixes.some(p => id.startsWith(p));

    if (!hasPrefix || id.includes("..") || id.startsWith("/") || id.endsWith("/")) {
        throw new McpError(ErrorCode.InvalidParams, "Project ID must follow the standard '[prefix]_[technical-name]' format and cannot contain '..' or slashes.");
    }
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

    switch (name) {
        case "register_session_context":
            return handleRegisterSession(toolArgs as { projectId: string }, ctx);

        case "sync_project_assets":
            return handleSyncProjectAssets(toolArgs as { manifest: ProjectManifest; internalDocs: string }, ctx);

        case "upload_project_asset":
            return handleUploadAsset(toolArgs as { fileName: string; base64Content: string }, ctx);

        case "get_global_topology":
            return handleGetTopology();

        case "read_project":
            return handleReadProject(toolArgs as { projectId: string; include?: string });

        case "post_global_discussion":
            return handlePostDiscussion(toolArgs as { message: string; category?: DiscussionMessage["category"] }, ctx);

        case "read_recent_discussion":
            return handleReadRecentDiscussion(toolArgs as { count?: number });

        case "update_global_strategy":
            return handleUpdateStrategy(toolArgs as { content: string }, ctx);

        case "sync_global_doc":
            return handleSyncGlobalDoc(toolArgs as { docId: string; title: string; content: string });

        case "list_global_docs":
            return handleListGlobalDocs();

        case "read_global_doc":
            return handleReadGlobalDoc(toolArgs as { docId: string });

        case "update_project":
            return handleUpdateProject(toolArgs as { projectId: string; patch: Partial<ProjectManifest> });

        case "rename_project":
            return handleRenameProject(toolArgs as { oldId: string; newId: string }, ctx);

        case "list_projects":
            return handleListProjects();

        case "moderator_delete_project":
            return handleRemoveProject(toolArgs as { projectId: string }, ctx);

        case "moderator_maintenance":
            return handleModeratorMaintenance(toolArgs as { action: "prune" | "clear"; count: number }, ctx);

        // --- Meeting Tools ---
        case "start_meeting":
            return handleStartMeeting(toolArgs as { topic: string }, ctx);

        case "end_meeting":
            return handleEndMeeting(toolArgs as { meetingId?: string; summary?: string }, ctx);

        case "list_meetings":
            return handleListMeetings(toolArgs as { status?: MeetingSession["status"] });

        case "read_meeting":
            return handleReadMeeting(toolArgs as { meetingId: string });

        case "archive_meeting":
            return handleArchiveMeeting(toolArgs as { meetingId: string });

        default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
}

// --- Session Handlers ---

function handleRegisterSession(args: { projectId: string }, ctx: ToolContext) {
    if (!args?.projectId) throw new McpError(ErrorCode.InvalidParams, "Missing required parameter: projectId");
    validateProjectId(args.projectId);
    ctx.setCurrentProject(args.projectId);
    return { content: [{ type: "text", text: `Active Nexus Context: ${args.projectId}` }] };
}

// --- Project Asset Handlers ---

async function handleSyncProjectAssets(
    args: { manifest: ProjectManifest; internalDocs: string },
    ctx: ToolContext
) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered. Call register_session_context first.");
    if (!args?.manifest || !args?.internalDocs) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'manifest' and 'internalDocs' are mandatory.");
    }

    const m = args.manifest;
    const requiredFields = ["id", "name", "description", "techStack", "relations", "lastUpdated", "repositoryUrl", "localPath", "endpoints", "apiSpec"];
    for (const field of requiredFields) {
        const value = (m as unknown as Record<string, unknown>)[field];
        if (value === undefined || value === null) {
            throw new McpError(ErrorCode.InvalidParams, `Project manifest incomplete. Missing field: ${field}`);
        }
    }

    validateProjectId(m.id);

    if (!await StorageManager.exists(m.localPath)) {
        throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${m.localPath}'. Please provide a valid directory path.`);
    }

    await StorageManager.saveProjectManifest(m);
    await StorageManager.saveProjectDocs(ctx.currentProject, args.internalDocs);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}@${ctx.currentProject}] Asset Sync: Full sync of manifest and docs.`);

    // Notify updates
    ctx.notifyResourceUpdate(`mcp://hub/projects/${m.id}/manifest`);
    ctx.notifyResourceUpdate(`mcp://hub/projects/${m.id}/internal-docs`);
    ctx.notifyResourceUpdate("mcp://hub/registry");
    ctx.notifyResourceUpdate("mcp://chat/global");

    return { content: [{ type: "text", text: "Project assets synchronized (Manifest + Docs)." }] };
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

async function handleReadProject(args: { projectId: string; include?: string }) {
    if (!args?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "'projectId' is required.");
    }
    const include = args.include || "summary";
    const manifest = await StorageManager.getProjectManifest(args.projectId);
    if (!manifest) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.projectId}' not found.`);

    let result: Record<string, unknown> = { projectId: args.projectId };

    switch (include) {
        case "manifest":
            result = { projectId: args.projectId, manifest };
            break;
        case "docs": {
            const docs = await StorageManager.getProjectDocs(args.projectId);
            result = { projectId: args.projectId, docs: docs || "(No documentation)" };
            break;
        }
        case "repo":
            result = { projectId: args.projectId, repositoryUrl: manifest.repositoryUrl };
            break;
        case "endpoints":
            result = { projectId: args.projectId, endpoints: manifest.endpoints };
            break;
        case "api":
            result = { projectId: args.projectId, apiSpec: manifest.apiSpec };
            break;
        case "relations":
            result = { projectId: args.projectId, relations: manifest.relations };
            break;
        case "summary":
            result = {
                projectId: args.projectId,
                name: manifest.name,
                description: manifest.description,
                techStack: manifest.techStack,
                repositoryUrl: manifest.repositoryUrl
            };
            break;
        case "all": {
            const docs = await StorageManager.getProjectDocs(args.projectId);
            result = { projectId: args.projectId, manifest, docs: docs || "(No documentation)" };
            break;
        }
        default:
            throw new McpError(ErrorCode.InvalidParams, `Invalid 'include' value: ${include}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

async function handleRenameProject(args: { oldId: string; newId: string }, ctx: ToolContext) {
    if (!args?.oldId || !args?.newId) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'oldId' and 'newId' are required.");
    }
    validateProjectId(args.newId);
    const updatedCount = await StorageManager.renameProject(args.oldId, args.newId);

    // Notify all affected project resources and registry
    ctx.notifyResourceUpdate("mcp://hub/registry");
    ctx.notifyResourceUpdate(`mcp://hub/projects/${args.newId}/manifest`);
    ctx.notifyResourceUpdate("mcp://get_global_topology"); // Topology changed

    return { content: [{ type: "text", text: `Project renamed: '${args.oldId}' → '${args.newId}'. Cascading updates: ${updatedCount} project(s).` }] };
}

// --- Global Handlers ---

async function handleGetTopology() {
    const topo = await StorageManager.calculateTopology();
    return { content: [{ type: "text", text: JSON.stringify(topo, null, 2) }] };
}

async function handlePostDiscussion(args: { message: string; category?: DiscussionMessage["category"] }, ctx: ToolContext) {
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
        ctx.notifyResourceUpdate(`mcp://meetings/${activeMeeting.id}`);
        ctx.notifyResourceUpdate("mcp://chat/global");

        return {
            content: [{
                type: "text",
                text: `Message posted to active meeting '${activeMeeting.topic}' (${activeMeeting.id})${args.category ? ` [${args.category}]` : ""}.`
            }]
        };
    } else {
        // Fallback to global discussion (backward compatibility)
        await StorageManager.addGlobalLog(from, args.message, args.category);
        ctx.notifyResourceUpdate("mcp://chat/global");

        return {
            content: [{
                type: "text",
                text: `Message broadcasted to Nexus Room (no active meeting)${args.category ? ` [${args.category}]` : ""}.`
            }]
        };
    }
}

async function handleReadRecentDiscussion(args: { count?: number; meetingId?: string }) {
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

async function handleRemoveProject(args: { projectId: string }, ctx: ToolContext) {
    if (!args?.projectId) throw new McpError(ErrorCode.InvalidParams, "projectId is required.");
    await StorageManager.deleteProject(args.projectId);
    ctx.notifyResourceUpdate("mcp://hub/registry");
    ctx.notifyResourceUpdate("mcp://get_global_topology");
    return { content: [{ type: "text", text: `Project '${args.projectId}' removed from Nexus.` }] };
}

async function handleSyncGlobalDoc(args: { docId: string; title: string; content: string }) {
    if (!args?.docId || !args?.title || !args?.content) {
        throw new McpError(ErrorCode.InvalidParams, "All fields required: docId, title, content.");
    }
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, CONFIG.instanceId);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Synced global doc: ${args.docId}`);
    return { content: [{ type: "text", text: `Global document '${args.docId}' synchronized.` }] };
}

async function handleListGlobalDocs() {
    const index = await StorageManager.listGlobalDocs();
    return { content: [{ type: "text", text: JSON.stringify(index, null, 2) }] };
}

async function handleReadGlobalDoc(args: { docId: string }) {
    if (!args?.docId) throw new McpError(ErrorCode.InvalidParams, "docId is required.");
    const content = await StorageManager.getGlobalDoc(args.docId);
    if (!content) throw new McpError(ErrorCode.InvalidRequest, `Global document '${args.docId}' not found.`);
    return { content: [{ type: "text", text: content }] };
}

// --- Admin Handlers ---

async function handleListProjects() {
    const registry = await StorageManager.listRegistry();
    const projects = Object.entries(registry.projects).map(([id, p]) => ({
        id,
        name: p.name,
        summary: p.summary,
        lastActive: p.lastActive
    }));
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
}

// --- Admin Handlers ---

async function handleModeratorMaintenance(args: { action: "prune" | "clear"; count: number }, ctx: ToolContext) {
    if (!args.action || args.count === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'action' and 'count' are mandatory for maintenance.");
    }

    if (args.action === "clear") {
        await StorageManager.clearGlobalLogs();
        ctx.notifyResourceUpdate("mcp://chat/global");
        return { content: [{ type: "text", text: "History wiped." }] };
    } else {
        try {
            await StorageManager.pruneGlobalLogs(args.count);
            ctx.notifyResourceUpdate("mcp://chat/global");
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
    ctx.notifyResourceUpdate("mcp://chat/global");

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

    const { meeting, suggestedSyncTargets } = await UnifiedMeetingStore.endMeeting(targetId, args.summary);

    ctx.notifyResourceUpdate("mcp://nexus/status");
    ctx.notifyResourceUpdate("mcp://chat/global");

    const suggestionText = suggestedSyncTargets.length > 0
        ? `\nSuggested sync targets: ${suggestedSyncTargets.join(", ")}`
        : "";

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

async function handleListMeetings(args: { status?: MeetingSession["status"] }) {
    const meetings = await UnifiedMeetingStore.listMeetings(args.status);
    return { content: [{ type: "text", text: JSON.stringify(meetings, null, 2) }] };
}

async function handleReadMeeting(args: { meetingId: string }) {
    if (!args.meetingId) throw new McpError(ErrorCode.InvalidParams, "meetingId is required.");
    const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new McpError(ErrorCode.InvalidRequest, `Meeting '${args.meetingId}' not found.`);
    return { content: [{ type: "text", text: JSON.stringify(meeting, null, 2) }] };
}

async function handleArchiveMeeting(args: { meetingId: string }) {
    if (!args.meetingId) throw new McpError(ErrorCode.InvalidParams, "meetingId is required.");
    await UnifiedMeetingStore.archiveMeeting(args.meetingId);
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

