import { getDatabase, initDatabase } from "./sqlite.js";
import { DiscussionMessage, MeetingSession, MeetingStatus } from "../types.js";

/**
 * SQLite-backed Meeting Store
 * Provides ACID-compliant concurrent access to meeting data
 */
export class SqliteMeetingStore {
    
    /**
     * Initialize the database
     */
    static init(): void {
        initDatabase();
    }

    /**
     * Generate a unique meeting ID
     */
    private static generateMeetingId(topic: string): string {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:T]/g, "").substring(0, 14);
        
        // Create slug from topic, fallback to base64 hash for non-ASCII
        let slug = topic
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .substring(0, 30);
        
        // If slug is empty (e.g., Chinese topic), use base64 of topic
        if (!slug) {
            slug = Buffer.from(topic).toString("base64").replace(/[^a-zA-Z0-9]/g, "").substring(0, 8).toLowerCase();
        }
        
        // Add random suffix for uniqueness (prevents collision in same second)
        const suffix = Math.random().toString(36).substring(2, 6);
        
        return `${timestamp}-${slug || "meeting"}-${suffix}`;
    }

    /**
     * Start a new meeting
     */
    static startMeeting(topic: string, initiator: string): MeetingSession {
        const db = getDatabase();
        const id = this.generateMeetingId(topic);
        const now = new Date().toISOString();
        const participants = JSON.stringify([initiator]);

        const stmt = db.prepare(`
            INSERT INTO meetings (id, topic, status, initiator, participants, created_at)
            VALUES (?, ?, 'active', ?, ?, ?)
        `);
        stmt.run(id, topic, initiator, participants, now);

        // Update state
        this.updateState("default_meeting", id);
        const activeMeetings = this.getActiveMeetingIds();
        activeMeetings.push(id);
        this.updateState("active_meetings", JSON.stringify(activeMeetings));

        return {
            id,
            topic,
            status: "active",
            startTime: now,
            initiator,
            participants: [initiator],
            messages: [],
            decisions: []
        };
    }

    /**
     * Get a meeting by ID
     */
    static getMeeting(id: string): MeetingSession | null {
        const db = getDatabase();
        
        const meetingStmt = db.prepare("SELECT * FROM meetings WHERE id = ?");
        const meeting = meetingStmt.get(id) as {
            id: string;
            topic: string;
            status: MeetingStatus;
            initiator: string;
            participants: string;
            created_at: string;
            closed_at: string | null;
            summary: string | null;
        } | undefined;

        if (!meeting) return null;

        // Get messages
        const messagesStmt = db.prepare(`
            SELECT sender as "from", text, category, timestamp
            FROM messages WHERE meeting_id = ?
            ORDER BY timestamp ASC
        `);
        const messages = messagesStmt.all(id) as DiscussionMessage[];

        // Get decisions
        const decisionsStmt = db.prepare(`
            SELECT content FROM decisions WHERE meeting_id = ?
            ORDER BY timestamp ASC
        `);
        const decisions = (decisionsStmt.all(id) as { content: string }[]).map(d => d.content);

        return {
            id: meeting.id,
            topic: meeting.topic,
            status: meeting.status,
            startTime: meeting.created_at,
            endTime: meeting.closed_at || undefined,
            initiator: meeting.initiator || "Unknown",
            participants: JSON.parse(meeting.participants),
            messages,
            decisions,
            summary: meeting.summary || undefined
        };
    }

    /**
     * Add a message to a meeting
     */
    static addMessage(meetingId: string, message: DiscussionMessage): void {
        const db = getDatabase();

        // Check meeting status
        const checkStmt = db.prepare("SELECT status, participants FROM meetings WHERE id = ?");
        const meeting = checkStmt.get(meetingId) as { status: string; participants: string } | undefined;
        
        if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
        if (meeting.status !== "active") throw new Error(`Meeting '${meetingId}' is ${meeting.status}, cannot add messages.`);

        // Insert message
        const insertStmt = db.prepare(`
            INSERT INTO messages (meeting_id, sender, text, category, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `);
        insertStmt.run(meetingId, message.from, message.text, message.category || null, message.timestamp);

        // Track participant
        const participants: string[] = JSON.parse(meeting.participants);
        if (!participants.includes(message.from)) {
            participants.push(message.from);
            const updateStmt = db.prepare("UPDATE meetings SET participants = ? WHERE id = ?");
            updateStmt.run(JSON.stringify(participants), meetingId);
        }

        // Extract decision
        if (message.category === "DECISION") {
            const decisionStmt = db.prepare(`
                INSERT INTO decisions (meeting_id, content, timestamp)
                VALUES (?, ?, ?)
            `);
            decisionStmt.run(meetingId, message.text, message.timestamp);
        }
    }

    /**
     * End a meeting
     */
    static endMeeting(meetingId: string, summary?: string, callerId?: string): { meeting: MeetingSession; suggestedSyncTargets: string[] } {
        const db = getDatabase();
        const now = new Date().toISOString();

        // Check meeting exists and is active
        const meeting = this.getMeeting(meetingId);
        if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
        if (meeting.status !== "active") throw new Error(`Meeting '${meetingId}' is already ${meeting.status}.`);

        // Permission check: Only initiator can end
        if (callerId && meeting.initiator && meeting.initiator !== callerId) {
            throw new Error(`Permission denied: Only initiator (${meeting.initiator}) can end this meeting.`);
        }

        // Update meeting
        const stmt = db.prepare(`
            UPDATE meetings SET status = 'closed', closed_at = ?, summary = ?
            WHERE id = ?
        `);
        stmt.run(now, summary || null, meetingId);

        // Update state
        const activeMeetings = this.getActiveMeetingIds().filter(id => id !== meetingId);
        this.updateState("active_meetings", JSON.stringify(activeMeetings));
        this.updateState("default_meeting", activeMeetings.length > 0 ? activeMeetings[activeMeetings.length - 1] : "");

        // Refresh meeting data
        const updatedMeeting = this.getMeeting(meetingId)!;
        
        // Suggest sync targets based on participants
        const suggestedSyncTargets = updatedMeeting.participants
            .map(p => p.split("@")[1])
            .filter((v, i, a) => v && v !== "Global" && a.indexOf(v) === i);

        return { meeting: updatedMeeting, suggestedSyncTargets };
    }

    /**
     * Archive a meeting
     */
    static archiveMeeting(meetingId: string, callerId?: string): void {
        const db = getDatabase();

        const meeting = this.getMeeting(meetingId);
        if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
        if (meeting.status === "active") throw new Error(`Meeting '${meetingId}' is still active. End it first.`);

        // Permission check: Only initiator can archive
        if (callerId && meeting.initiator && meeting.initiator !== callerId) {
            throw new Error(`Permission denied: Only initiator (${meeting.initiator}) can archive this meeting.`);
        }

        const stmt = db.prepare("UPDATE meetings SET status = 'archived' WHERE id = ?");
        stmt.run(meetingId);
    }

    /**
     * Reopen a closed or archived meeting
     */
    static reopenMeeting(meetingId: string, _callerId?: string): MeetingSession {
        const db = getDatabase();
        
        const meeting = this.getMeeting(meetingId);
        if (!meeting) throw new Error(`Meeting '${meetingId}' not found.`);
        if (meeting.status === "active") throw new Error(`Meeting '${meetingId}' is already active.`);

        // Update status to active
        const stmt = db.prepare("UPDATE meetings SET status = 'active', closed_at = NULL WHERE id = ?");
        stmt.run(meetingId);

        // Update state
        const activeMeetings = this.getActiveMeetingIds();
        if (!activeMeetings.includes(meetingId)) {
            activeMeetings.push(meetingId);
            this.updateState("active_meetings", JSON.stringify(activeMeetings));
        }
        this.updateState("default_meeting", meetingId);

        return this.getMeeting(meetingId)!;
    }

    /**
     * List meetings with optional status filter
     */
    static listMeetings(status?: MeetingStatus): Array<{
        id: string;
        topic: string;
        status: MeetingStatus;
        startTime: string;
        participantCount: number;
    }> {
        const db = getDatabase();
        
        let query = "SELECT id, topic, status, participants, created_at FROM meetings";
        const params: string[] = [];
        
        if (status) {
            query += " WHERE status = ?";
            params.push(status);
        }
        
        query += " ORDER BY created_at DESC";
        
        const stmt = db.prepare(query);
        const meetings = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
            id: string;
            topic: string;
            status: MeetingStatus;
            participants: string;
            created_at: string;
        }>;

        return meetings.map(m => ({
            id: m.id,
            topic: m.topic,
            status: m.status,
            startTime: m.created_at,
            participantCount: JSON.parse(m.participants).length
        }));
    }

    /**
     * Get the current active meeting
     */
    static getActiveMeeting(): MeetingSession | null {
        const defaultId = this.getState("default_meeting");
        if (!defaultId) return null;
        return this.getMeeting(defaultId);
    }

    /**
     * Get recent messages from a meeting
     */
    static getRecentMessages(count: number = 10, meetingId?: string): DiscussionMessage[] {
        const db = getDatabase();
        
        const targetId = meetingId || this.getState("default_meeting");
        if (!targetId) return [];

        const stmt = db.prepare(`
            SELECT sender as "from", text, category, timestamp
            FROM messages WHERE meeting_id = ?
            ORDER BY timestamp DESC LIMIT ?
        `);
        const messages = stmt.all(targetId, count) as DiscussionMessage[];
        
        // Reverse to get chronological order
        return messages.reverse();
    }

    /**
     * Get meeting state value
     */
    static getState(key: string): string {
        const db = getDatabase();
        const stmt = db.prepare("SELECT value FROM meeting_state WHERE key = ?");
        const row = stmt.get(key) as { value: string } | undefined;
        return row?.value || "";
    }

    /**
     * Update meeting state value
     */
    private static updateState(key: string, value: string): void {
        const db = getDatabase();
        const stmt = db.prepare("INSERT OR REPLACE INTO meeting_state (key, value) VALUES (?, ?)");
        stmt.run(key, value);
    }

    /**
     * Get list of active meeting IDs
     */
    private static getActiveMeetingIds(): string[] {
        const value = this.getState("active_meetings");
        try {
            return JSON.parse(value) || [];
        } catch {
            return [];
        }
    }
}
