import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";

import { CONFIG } from "../config.js";
import { StorageManager } from "../storage/index.js";
import { ProjectManifest } from "../types.js";

export interface ToolContext {
    currentProject: string | null;
    setCurrentProject: (id: string) => void;
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
            return handlePostDiscussion(toolArgs as { message: string }, ctx);

        case "update_global_strategy":
            return handleUpdateStrategy(toolArgs as { content: string });

        case "sync_global_doc":
            return handleSyncGlobalDoc(toolArgs as { docId: string; title: string; content: string });

        case "list_global_docs":
            return handleListGlobalDocs();

        case "read_global_doc":
            return handleReadGlobalDoc(toolArgs as { docId: string });

        case "update_project":
            return handleUpdateProject(toolArgs as { projectId: string; patch: Partial<ProjectManifest> });

        case "rename_project":
            return handleRenameProject(toolArgs as { oldId: string; newId: string });

        case "moderator_maintenance":
            return handleModeratorMaintenance(toolArgs as { action: "prune" | "clear"; count: number });

        default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
}

// --- Session Handlers ---

function handleRegisterSession(args: { projectId: string }, ctx: ToolContext) {
    if (!args?.projectId) throw new McpError(ErrorCode.InvalidParams, "Missing required parameter: projectId");
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
    if (!m.id || !m.name || !m.description || !m.techStack || !m.relations || !m.lastUpdated || !m.repositoryUrl || !m.localPath || !m.endpoints || !m.apiSpec) {
        throw new McpError(ErrorCode.InvalidParams, "Project manifest incomplete. Required: id, name, description, techStack, relations, lastUpdated, repositoryUrl, localPath, endpoints, apiSpec.");
    }

    if (m.id.includes("..") || m.id.startsWith("/") || m.id.endsWith("/")) {
        throw new McpError(ErrorCode.InvalidParams, "Project ID cannot contain '..' or start/end with '/'. Use '/' for namespacing (e.g., 'parent/child').");
    }

    if (!await StorageManager.exists(m.localPath)) {
        throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${m.localPath}'. Please provide a valid directory path.`);
    }

    await StorageManager.saveProjectManifest(m);
    await StorageManager.saveProjectDocs(ctx.currentProject, args.internalDocs);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}@${ctx.currentProject}] Asset Sync: Full sync of manifest and docs.`);

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

async function handleRenameProject(args: { oldId: string; newId: string }) {
    if (!args?.oldId || !args?.newId) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'oldId' and 'newId' are required.");
    }
    if (args.newId.includes("..") || args.newId.startsWith("/") || args.newId.endsWith("/")) {
        throw new McpError(ErrorCode.InvalidParams, "New ID cannot contain '..' or start/end with '/'.");
    }
    const updatedCount = await StorageManager.renameProject(args.oldId, args.newId);
    return { content: [{ type: "text", text: `Project renamed: '${args.oldId}' → '${args.newId}'. Cascading updates: ${updatedCount} project(s).` }] };
}

// --- Global Handlers ---

async function handleGetTopology() {
    const topo = await StorageManager.calculateTopology();
    return { content: [{ type: "text", text: JSON.stringify(topo, null, 2) }] };
}

async function handlePostDiscussion(args: { message: string }, ctx: ToolContext) {
    if (!args?.message) throw new McpError(ErrorCode.InvalidParams, "Message content cannot be empty.");
    await StorageManager.addGlobalLog(`${CONFIG.instanceId}@${ctx.currentProject || "Global"}`, args.message);
    return { content: [{ type: "text", text: "Message broadcasted." }] };
}

async function handleUpdateStrategy(args: { content: string }) {
    if (!args?.content) throw new McpError(ErrorCode.InvalidParams, "Strategy content cannot be empty.");
    await fs.writeFile(StorageManager.globalBlueprint, args.content);
    await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Updated Coordination Strategy.`);
    return { content: [{ type: "text", text: "Strategy updated." }] };
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

async function handleModeratorMaintenance(args: { action: "prune" | "clear"; count: number }) {
    if (!args.action || args.count === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'action' and 'count' are mandatory for maintenance.");
    }

    if (args.action === "clear") {
        await StorageManager.clearGlobalLogs();
        return { content: [{ type: "text", text: "History wiped." }] };
    } else {
        try {
            await StorageManager.pruneGlobalLogs(args.count);
            return { content: [{ type: "text", text: `Pruned ${args.count} logs.` }] };
        } catch {
            return { content: [{ type: "text", text: "Prune operation failed due to malformed logs or missing file." }] };
        }
    }
}
