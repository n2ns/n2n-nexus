import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StorageManager } from "../storage/index.js";
import { ToolContext } from "../types.js";
import { TOOL_REGISTRY } from "./schemas.js";

import {
    handleRegisterSession,
    handleSyncProjectAssets,
    handleUploadAsset,
    handleSearchProjects,
    handleGetTopology,
    handleSendMessage,
    handleReadMessages,
    handleUpdateStrategy,
    handleSyncGlobalDoc,
    handleUpdateProject,
    handleRenameProject,
    handleRemoveProject,
    handleHostMaintenance,
    handleStartMeeting,
    handleEndMeeting,
    handleArchiveMeeting,
    handleReopenMeeting,
    handleCreateTask,
    handleGetTask,
    handleListTasks,
    handleUpdateTask,
    handleCancelTask
} from "./handlers/index.js";

/**
 * Handles all tool executions
 */
export async function handleToolCall(
    name: string,
    toolArgs: Record<string, unknown>,
    ctx: ToolContext
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    await StorageManager.init();

    // --- Schema Validation ---
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
        const idPrefix = ctx.requestId ? `[Req:${ctx.requestId}] ` : "";
        throw new McpError(ErrorCode.InvalidParams, `${idPrefix}Schema validation failed: ${error.message}`);
    }

    switch (name) {
        case "register_session_context":
            return handleRegisterSession(validatedArgs, ctx);

        case "sync_project_assets":
            return handleSyncProjectAssets(validatedArgs, ctx);

        case "upload_project_asset":
            return handleUploadAsset(validatedArgs, ctx);

        case "search_projects":
            return handleSearchProjects(validatedArgs);

        case "get_global_topology":
            return handleGetTopology(validatedArgs);

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

        case "host_delete_project":
            return handleRemoveProject(validatedArgs, ctx);

        case "host_maintenance":
            return handleHostMaintenance(validatedArgs, ctx);

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
            throw new McpError(ErrorCode.MethodNotFound, `Tool handler not implemented: ${name}`);
    }
}
