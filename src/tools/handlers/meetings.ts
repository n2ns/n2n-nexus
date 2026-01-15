import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../../config/index.js";
import { StorageManager } from "../../storage/index.js";
import { UnifiedMeetingStore } from "../../storage/store.js";
import { ToolContext } from "../../types.js";

export async function handleStartMeeting(args: { topic: string }, ctx: ToolContext) {
    // if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");
    const meeting = await UnifiedMeetingStore.startMeeting(args.topic, CONFIG.instanceId);
    if (ctx.currentProject) {
        ctx.notifyResourceUpdate(`mcp://nexus/projects/${ctx.currentProject}/meetings/active`);
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting started: ${args.topic}`,
                meetingId: meeting.id,
                status: meeting.status,
                topic: meeting.topic
            })
        }]
    };
}

export async function handleEndMeeting(args: { meetingId?: string; summary?: string }, ctx: ToolContext) {
    // if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");

    let id = args.meetingId;
    if (!id) {
        const active = await UnifiedMeetingStore.getActiveMeeting();
        if (active) id = active.id;
    }

    if (!id) throw new McpError(ErrorCode.InvalidRequest, "No active meeting found to end.");

    // Idempotency handled in try/catch block below
    let meeting, summary;
    try {
        const result = await UnifiedMeetingStore.endMeeting(id, args.summary, CONFIG.instanceId);
        meeting = result.meeting;
        summary = result.meeting.summary;
    } catch (error: any) {
        if (error.message.includes("already closed")) {
            // Idempotency: If already closed, return the current state
            const existing = await UnifiedMeetingStore.getMeeting(id);
            if (existing && existing.status === "closed") {
                meeting = existing;
                summary = existing.summary;
            } else {
                throw error;
            }
        } else {
            throw error;
        }
    }

    if (ctx.currentProject) {
        ctx.notifyResourceUpdate(`mcp://nexus/projects/${ctx.currentProject}/meetings/active`);
        ctx.notifyResourceUpdate(`mcp://nexus/projects/${ctx.currentProject}/meetings/history`);
    }

    if (summary) {
        await StorageManager.addGlobalLog("SYSTEM", `Meeting Ended: ${meeting.topic}. Summary: ${summary}`);
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                message: `Meeting ended: ${meeting.topic}`,
                meetingId: id,
                status: "closed",
                summary: summary
            })
        }]
    };
}

export async function handleArchiveMeeting(args: { meetingId: string }, _ctx: ToolContext) {
    const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new McpError(ErrorCode.InvalidRequest, `Meeting '${args.meetingId}' not found.`);

    await UnifiedMeetingStore.archiveMeeting(args.meetingId, CONFIG.instanceId);
    return {
        content: [{
            type: "text",
            text: `Meeting '${meeting.topic}' (ID: ${args.meetingId}) has been archived.`
        }]
    };
}

export async function handleReopenMeeting(args: { meetingId: string }, ctx: ToolContext) {
    if (!ctx.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");
    const meeting = await UnifiedMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new McpError(ErrorCode.InvalidRequest, `Meeting '${args.meetingId}' not found.`);

    await UnifiedMeetingStore.reopenMeeting(args.meetingId, CONFIG.instanceId);
    ctx.notifyResourceUpdate(`mcp://nexus/projects/${ctx.currentProject}/meetings/active`);

    return {
        content: [{
            type: "text",
            text: `Meeting '${meeting.topic}' (ID: ${args.meetingId}) is now active again in project '${ctx.currentProject}'.`
        }]
    };
}
