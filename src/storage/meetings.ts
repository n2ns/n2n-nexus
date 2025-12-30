import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { DiscussionMessage, MeetingSession, MeetingState } from "../types.js";
import { AsyncMutex } from "../utils/async-mutex.js";

/**
 * MeetingStore - Handles all meeting-related storage operations
 */
export class MeetingStore {
    private static meetingLock = new AsyncMutex();
    private static stateLock = new AsyncMutex();

    // --- Path Definitions ---
    static get meetingsDir() { return path.join(CONFIG.rootStorage, "meetings"); }
    static get stateFile() { return path.join(CONFIG.rootStorage, "global", "meeting_state.json"); }

    /**
     * Initialize meeting storage directories
     */
    static async init() {
        await fs.mkdir(this.meetingsDir, { recursive: true });
        await this.loadStateSafe();
    }

    /**
     * Check if a path exists
     */
    private static async exists(p: string): Promise<boolean> {
        try { await fs.access(p); return true; } catch { return false; }
    }

    /**
     * Load meeting state with self-healing
     */
    private static async loadStateSafe(): Promise<MeetingState> {
        const defaultState: MeetingState = { activeMeetings: [], defaultMeetingId: null };
        try {
            if (!await this.exists(this.stateFile)) {
                await fs.writeFile(this.stateFile, JSON.stringify(defaultState, null, 2), "utf-8");
                return defaultState;
            }
            const content = await fs.readFile(this.stateFile, "utf-8");
            const cleanContent = content.replace(/^\uFEFF/, '').trim();
            if (!cleanContent) throw new Error("Empty file");
            return JSON.parse(cleanContent);
        } catch (e) {
            console.warn(`[MeetingStore] Repairing corrupted state file. Error: ${(e as Error).message}`);
            await fs.writeFile(this.stateFile, JSON.stringify(defaultState, null, 2), "utf-8");
            return defaultState;
        }
    }

    /**
     * Get current meeting state
     */
    static async getState(): Promise<MeetingState> {
        return this.loadStateSafe();
    }

    /**
     * Save meeting state
     */
    private static async saveState(state: MeetingState): Promise<void> {
        await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf-8");
    }

    /**
     * Generate a unique meeting ID
     */
    private static generateMeetingId(topic: string): string {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:T]/g, '').substring(0, 14);
        
        // Create slug from topic, fallback to base64 hash for non-ASCII
        let slug = topic
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 30);
        
        // If slug is empty (e.g., Chinese topic), use base64 of topic
        if (!slug) {
            slug = Buffer.from(topic).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 8).toLowerCase();
        }
        
        // Add random suffix for uniqueness (prevents collision in same second)
        const suffix = Math.random().toString(36).substring(2, 6);
        
        return `${timestamp}-${slug || 'meeting'}-${suffix}`;
    }

    /**
     * Get the file path for a meeting
     */
    private static getMeetingPath(id: string): string {
        return path.join(this.meetingsDir, `${id}.json`);
    }

    /**
     * Start a new meeting
     */
    static async startMeeting(topic: string, initiator: string): Promise<MeetingSession> {
        await this.init();

        return this.stateLock.withLock(async () => {
            const id = this.generateMeetingId(topic);
            const meeting: MeetingSession = {
                id,
                topic,
                status: "active",
                startTime: new Date().toISOString(),
                initiator,
                participants: [initiator],
                messages: [],
                decisions: []
            };

            // Save meeting file
            await fs.writeFile(this.getMeetingPath(id), JSON.stringify(meeting, null, 2), "utf-8");

            // Update state
            const state = await this.loadStateSafe();
            state.activeMeetings.push(id);
            state.defaultMeetingId = id;
            await this.saveState(state);

            return meeting;
        });
    }

    /**
     * Get a meeting by ID
     */
    static async getMeeting(id: string): Promise<MeetingSession | null> {
        const meetingPath = this.getMeetingPath(id);
        if (!await this.exists(meetingPath)) return null;
        const content = await fs.readFile(meetingPath, "utf-8");
        return JSON.parse(content);
    }

    /**
     * Add a message to a meeting
     */
    static async addMessage(meetingId: string, message: DiscussionMessage): Promise<void> {
        await this.meetingLock.withLock(async () => {
            const meeting = await this.getMeeting(meetingId);
            if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
            if (meeting.status !== "active") throw new Error(`Meeting '${meetingId}' is ${meeting.status}, cannot add messages.`);

            // Add message
            meeting.messages.push(message);

            // Track participant
            if (!meeting.participants.includes(message.from)) {
                meeting.participants.push(message.from);
            }

            // Extract decisions
            if (message.category === "DECISION") {
                meeting.decisions.push(message.text);
            }

            await fs.writeFile(this.getMeetingPath(meetingId), JSON.stringify(meeting, null, 2), "utf-8");
        });
    }

    /**
     * End a meeting (close it)
     */
    static async endMeeting(meetingId: string, summary?: string, callerId?: string): Promise<{ meeting: MeetingSession; suggestedSyncTargets: string[] }> {
        return this.stateLock.withLock(async () => {
            const meeting = await this.getMeeting(meetingId);
            if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
            if (meeting.status !== "active") throw new Error(`Meeting '${meetingId}' is already ${meeting.status}.`);

            // Permission check: Only initiator can end
            if (callerId && meeting.initiator && meeting.initiator !== callerId) {
                throw new Error(`Permission denied: Only initiator (${meeting.initiator}) can end this meeting.`);
            }

            // Close the meeting
            meeting.status = "closed";
            meeting.endTime = new Date().toISOString();
            if (summary) meeting.summary = summary;

            await fs.writeFile(this.getMeetingPath(meetingId), JSON.stringify(meeting, null, 2), "utf-8");

            // Update state - remove from active meetings
            const state = await this.loadStateSafe();
            state.activeMeetings = state.activeMeetings.filter(id => id !== meetingId);
            state.defaultMeetingId = state.activeMeetings.length > 0 
                ? state.activeMeetings[state.activeMeetings.length - 1] 
                : null;
            await this.saveState(state);

            // Suggest sync targets based on participants (extract project IDs)
            const suggestedSyncTargets = meeting.participants
                .map(p => p.split('@')[1])
                .filter((v, i, a) => v && v !== "Global" && a.indexOf(v) === i);

            return { meeting, suggestedSyncTargets };
        });
    }

    /**
     * Archive a closed meeting
     */
    static async archiveMeeting(meetingId: string, callerId?: string): Promise<void> {
        const meeting = await this.getMeeting(meetingId);
        if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
        if (meeting.status === "active") throw new Error(`Meeting '${meetingId}' is still active. End it first.`);

        // Permission check: Only initiator can archive
        if (callerId && meeting.initiator && meeting.initiator !== callerId) {
            throw new Error(`Permission denied: Only initiator (${meeting.initiator}) can archive this meeting.`);
        }

        meeting.status = "archived";
        await fs.writeFile(this.getMeetingPath(meetingId), JSON.stringify(meeting, null, 2), "utf-8");
    }

    /**
     * List all meetings with optional status filter
     */
    static async listMeetings(status?: MeetingSession["status"]): Promise<Array<{ id: string; topic: string; status: MeetingSession["status"]; startTime: string; participantCount: number }>> {
        await this.init();
        const files = await fs.readdir(this.meetingsDir);
        const meetings: Array<{ id: string; topic: string; status: MeetingSession["status"]; startTime: string; participantCount: number }> = [];

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const id = file.replace('.json', '');
            const meeting = await this.getMeeting(id);
            if (!meeting) continue;
            if (status && meeting.status !== status) continue;
            meetings.push({
                id: meeting.id,
                topic: meeting.topic,
                status: meeting.status,
                startTime: meeting.startTime,
                participantCount: meeting.participants.length
            });
        }

        // Sort by startTime descending
        return meetings.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    }

    /**
     * Get the current active meeting (for auto-routing)
     */
    static async getActiveMeeting(): Promise<MeetingSession | null> {
        const state = await this.getState();
        if (!state.defaultMeetingId) return null;
        return this.getMeeting(state.defaultMeetingId);
    }

    /**
     * Get recent messages from the active meeting
     */
    static async getRecentMessages(count: number = 10, meetingId?: string): Promise<DiscussionMessage[]> {
        const targetId = meetingId || (await this.getState()).defaultMeetingId;
        if (!targetId) return [];

        const meeting = await this.getMeeting(targetId);
        if (!meeting) return [];

        return meeting.messages.slice(-count);
    }
}
