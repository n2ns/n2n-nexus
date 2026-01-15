import { z } from "zod";

export const CreateTaskSchema = z.object({
    source_meeting_id: z.string().optional().describe("Link task to a meeting for traceability"),
    metadata: z.object({}).passthrough().optional().describe("Custom task parameters"),
    ttl: z.number().int().positive().optional().describe("Time-to-live in milliseconds")
});

export const GetTaskSchema = z.object({
    taskId: z.string()
});

export const ListTasksSchema = z.object({
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    limit: z.number().int().positive().optional().default(50)
});

export const UpdateTaskSchema = z.object({
    taskId: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    progress: z.number().min(0).max(1).optional(),
    result_uri: z.string().optional(),
    error_message: z.string().optional()
});

export const CancelTaskSchema = z.object({
    taskId: z.string()
});
