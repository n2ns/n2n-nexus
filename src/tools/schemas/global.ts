import { z } from "zod";
import { ProjectIdSchema } from "./base.js";

export const TopologySchema = z.object({
    projectId: ProjectIdSchema.optional().describe("Focus on specific project's subgraph. Omit for summary list.")
});

export const SendMessageSchema = z.object({
    message: z.string().min(1, "Message cannot be empty"),
    category: z.enum(["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT", "message", "SYSTEM"]).optional()
});

export const ReadMessagesSchema = z.object({
    count: z.number().int().positive().optional().default(10),
    meetingId: z.string().optional()
});

export const UpdateStrategySchema = z.object({
    content: z.string().min(1, "Strategy content cannot be empty")
});

export const SyncGlobalDocSchema = z.object({
    docId: z.string(),
    title: z.string(),
    content: z.string()
});

export const HostMaintenanceSchema = z.object({
    action: z.enum(["prune", "clear"]),
    count: z.number().int().min(0)
});
