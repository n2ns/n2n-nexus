import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../../config/index.js";
import { StorageManager } from "../../storage/index.js";
import { UnifiedMeetingStore } from "../../storage/store.js";
import { DiscussionMessage, ToolContext } from "../../types.js";

export async function handleGetTopology(args: { projectId?: string }) {
    const topology = await StorageManager.calculateTopology(args.projectId);
    return {
        content: [{
            type: "text",
            text: JSON.stringify(topology, null, 2)
        }]
    };
}

export async function handleSendMessage(args: { message: string; category?: DiscussionMessage["category"] }, ctx: ToolContext) {
    if (!args.message) throw new McpError(ErrorCode.InvalidParams, "Message content is required.");

    const activeMeeting = await UnifiedMeetingStore.getActiveMeeting();

    // Project context must match if meeting exists
    const meetingId = (activeMeeting && ctx.currentProject) ? activeMeeting.id : null;

    if (meetingId) {
        const message: DiscussionMessage = {
            from: CONFIG.instanceId,
            text: args.message,
            category: args.category || "message",
            timestamp: new Date().toISOString()
        };
        await UnifiedMeetingStore.addMessage(meetingId, message);
        ctx.notifyResourceUpdate(`mcp://nexus/projects/${ctx.currentProject}/meetings/active`);
        return {
            content: [{
                type: "text",
                text: `[Meeting Message] Sent to ${meetingId}.`
            }]
        };
    } else {
        await StorageManager.addGlobalLog(CONFIG.instanceId, args.message, args.category);
        ctx.notifyResourceUpdate("mcp://nexus/chat/global");
        return {
            content: [{
                type: "text",
                text: `[Global Message] Logged to Nexus Hub.`
            }]
        };
    }
}

export async function handleReadMessages(args: { count?: number; meetingId?: string }) {
    const count = args.count || 20;

    if (args.meetingId) {
        const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
        if (!meeting) throw new McpError(ErrorCode.InvalidRequest, `Meeting '${args.meetingId}' not found.`);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    meeting: meeting.topic,
                    messages: meeting.messages.slice(-count)
                }, null, 2)
            }]
        };
    } else {
        const logs = await StorageManager.getRecentLogs(count);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    hub: "Global",
                    messages: logs
                }, null, 2)
            }]
        };
    }
}

export async function handleUpdateStrategy(args: { content: string }, _ctx: ToolContext) {
    if (!args.content) throw new McpError(ErrorCode.InvalidParams, "Strategy content is required.");
    await StorageManager.saveGlobalDoc("strategy", "Global Collaboration Strategy", args.content, CONFIG.instanceId);
    return {
        content: [{
            type: "text",
            text: "Global Collaboration Strategy updated successfully."
        }]
    };
}

export async function handleSyncGlobalDoc(args: { docId: string; title: string; content: string }) {
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, CONFIG.instanceId);
    return {
        content: [{
            type: "text",
            text: `Global document '${args.title}' (ID: ${args.docId}) synchronized.`
        }]
    };
}

export async function handleHostMaintenance(args: { action: "prune" | "clear"; count: number }, ctx: ToolContext) {
    if (args.action === "clear") {
        await StorageManager.clearGlobalLogs();
        return { content: [{ type: "text", text: "History wiped." }] };
    } else {
        await StorageManager.pruneGlobalLogs(args.count);
        return { content: [{ type: "text", text: `Pruned oldest ${args.count} messages.` }] };
    }
}
