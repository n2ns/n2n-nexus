import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
    createTask, getTask, listTasks, updateTask, cancelTask,
    TaskStatus
} from "../../storage/tasks.js";

export async function handleCreateTask(args: { source_meeting_id?: string; metadata?: Record<string, unknown>; ttl?: number }) {
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
                task: task
            }, null, 2)
        }]
    };
}

export async function handleGetTask(args: { taskId: string }) {
    const task = await getTask(args.taskId);
    if (!task) throw new McpError(ErrorCode.InvalidRequest, `Task '${args.taskId}' not found.`);

    return {
        content: [{
            type: "text",
            text: JSON.stringify(task, null, 2)
        }]
    };
}

export async function handleListTasks(args: { status?: TaskStatus; limit?: number }) {
    const tasks = await listTasks(args.status, args.limit);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                count: tasks.length,
                tasks: tasks
            }, null, 2)
        }]
    };
}

export async function handleUpdateTask(args: { taskId: string; status?: TaskStatus; progress?: number; result_uri?: string; error_message?: string }) {
    const updated = await updateTask(args.taskId, {
        status: args.status,
        progress: args.progress,
        result_uri: args.result_uri,
        error_message: args.error_message
    });

    if (!updated) throw new McpError(ErrorCode.InvalidRequest, `Task '${args.taskId}' not found or update failed.`);

    return {
        content: [{
            type: "text",
            text: `Task '${args.taskId}' updated successfully.`
        }]
    };
}

export async function handleCancelTask(args: { taskId: string }) {
    const cancelled = await cancelTask(args.taskId);
    if (!cancelled) throw new McpError(ErrorCode.InvalidRequest, `Task '${args.taskId}' not found or cannot be cancelled (already completed/failed).`);

    return {
        content: [{
            type: "text",
            text: `Task '${args.taskId}' has been cancelled.`
        }]
    };
}
