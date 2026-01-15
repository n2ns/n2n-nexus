import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../../config/index.js";
import { StorageManager } from "../../storage/index.js";
import { createTask, updateTask } from "../../storage/tasks.js";
import { ProjectManifest, ToolContext } from "../../types.js";

/**
 * ASYNC TRIAL: sync_project_assets now uses the Task primitive for non-blocking operation.
 * Returns a taskId immediately; actual sync happens in background.
 */
export async function handleSyncProjectAssets(
    args: { manifest: ProjectManifest; internalDocs: string },
    ctx: ToolContext
) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered. Call register_session_context first.");

    const m = args.manifest;

    if (!await StorageManager.exists(m.localPath)) {
        throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${m.localPath}'. Please provide a valid directory path.`);
    }

    const task = createTask({
        metadata: {
            operation: "sync_project_assets",
            projectId: m.id,
            manifestName: m.name,
            initiator: CONFIG.instanceId
        }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.1 });
            await StorageManager.saveProjectManifest(m);
            updateTask(task.id, { progress: 0.4 });
            await StorageManager.saveProjectDocs(ctx.currentProject!, args.internalDocs);
            updateTask(task.id, { progress: 0.7 });
            await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}@${ctx.currentProject}] Asset Sync: Full sync of manifest and docs.`);
            updateTask(task.id, { progress: 0.9 });
            ctx.notifyResourceUpdate(`mcp://nexus/projects/${m.id}/manifest`);
            ctx.notifyResourceUpdate(`mcp://nexus/projects/${m.id}/internal-docs`);
            ctx.notifyResourceUpdate("mcp://nexus/hub/registry");
            ctx.notifyResourceUpdate("mcp://nexus/chat/global");
            updateTask(task.id, {
                status: "completed",
                progress: 1.0,
                result_uri: `mcp://nexus/projects/${m.id}/manifest`
            });
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
                message: "Sync task created. Use get_task to poll for completion.",
                task_id: task.id,
                status: "pending",
                poll_hint: "Call get_task with this task_id to check progress."
            }, null, 2)
        }]
    };
}

export async function handleUploadAsset(args: { fileName: string; base64Content: string }, ctx: ToolContext) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");
    if (!args?.base64Content || !args?.fileName) {
        throw new McpError(ErrorCode.InvalidParams, "Both 'base64Content' and 'fileName' are required.");
    }
    const buff = Buffer.from(args.base64Content, "base64");
    await StorageManager.saveAsset(ctx.currentProject, args.fileName, buff);
    return { content: [{ type: "text", text: `Asset '${args.fileName}' saved to project '${ctx.currentProject}'.` }] };
}

export async function handleUpdateProject(args: { projectId: string; patch: Partial<ProjectManifest> }) {
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

export async function handleRenameProject(args: { oldId: string; newId: string }, ctx: ToolContext) {
    const exists = await StorageManager.getProjectManifest(args.oldId);
    if (!exists) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.oldId}' not found.`);

    const task = createTask({
        metadata: {
            operation: "rename_project",
            oldId: args.oldId,
            newId: args.newId,
            initiator: CONFIG.instanceId
        }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.2 });
            const updatedCount = await StorageManager.renameProject(args.oldId, args.newId);
            updateTask(task.id, { progress: 0.8 });
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

export async function handleSearchProjects(args: { query: string; limit?: number }) {
    if (!args.query) throw new McpError(ErrorCode.InvalidParams, "Query is required.");
    const limit = args.limit || 10;
    const registry = await StorageManager.listRegistry();
    const query = args.query.toLowerCase();

    const matches = Object.entries(registry.projects)
        .filter(([id, p]) =>
            id.toLowerCase().includes(query) ||
            (p.name && p.name.toLowerCase().includes(query)) ||
            (p.summary && p.summary.toLowerCase().includes(query))
        )
        .map(([id, p]) => ({
            id: id,
            name: p.name || id,
            description: p.summary
        }))
        .slice(0, limit);

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                query: args.query,
                count: matches.length,
                results: matches
            }, null, 2)
        }]
    };
}

export async function handleRemoveProject(args: { projectId: string }, ctx: ToolContext) {
    const exists = await StorageManager.getProjectManifest(args.projectId);
    if (!exists) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.projectId}' not found.`);

    const task = createTask({
        metadata: {
            operation: "delete_project",
            projectId: args.projectId,
            initiator: CONFIG.instanceId
        }
    });

    setImmediate(async () => {
        try {
            updateTask(task.id, { status: "running", progress: 0.3 });
            await StorageManager.deleteProject(args.projectId);
            updateTask(task.id, { progress: 0.9 });
            ctx.notifyResourceUpdate("mcp://nexus/hub/registry");
            ctx.notifyResourceUpdate("mcp://get_global_topology");
            updateTask(task.id, {
                status: "completed",
                progress: 1.0
            });
            await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Task Completed: Project deleted '${args.projectId}'.`);
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
