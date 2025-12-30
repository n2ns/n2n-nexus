/**
 * Meeting Store Entry Point
 * 
 * Provides a unified interface that automatically selects between:
 * - SQLite backend (preferred, for concurrent access safety)
 * - JSON backend (fallback, for environments without native module support)
 */

import { DiscussionMessage, MeetingSession, MeetingStatus } from "../types.js";

// Lazy-loaded store implementation
let storeType: "sqlite" | "json" | null = null;
let SqliteStore: typeof import("./sqlite-meeting.js").SqliteMeetingStore | null = null;
let JsonStore: typeof import("./meetings.js").MeetingStore | null = null;

/**
 * Detect and initialize the appropriate store
 */
async function getStore() {
    if (storeType === "sqlite" && SqliteStore) {
        return { type: "sqlite" as const, store: SqliteStore };
    }
    if (storeType === "json" && JsonStore) {
        return { type: "json" as const, store: JsonStore };
    }

    // Try SQLite first
    try {
        // Dynamic import to avoid bundling issues
        const sqliteModule = await import("./sqlite-meeting.js");
        SqliteStore = sqliteModule.SqliteMeetingStore;
        SqliteStore.init();
        storeType = "sqlite";
        console.error("[Nexus MeetingStore] Using SQLite backend");
        return { type: "sqlite" as const, store: SqliteStore };
    } catch (e) {
        console.error("[Nexus MeetingStore] SQLite unavailable:", (e as Error).message);
        console.error("[Nexus MeetingStore] Falling back to JSON backend");
        console.warn("[Nexus MeetingStore] ⚠️ JSON mode is single-process only. For multi-IDE environments, install better-sqlite3.");
        
        // Fall back to JSON
        const jsonModule = await import("./meetings.js");
        JsonStore = jsonModule.MeetingStore;
        storeType = "json";
        return { type: "json" as const, store: JsonStore };
    }
}

/**
 * Unified Meeting Store Interface
 */
export const UnifiedMeetingStore = {
    /**
     * Start a new meeting
     */
    async startMeeting(topic: string, initiator: string): Promise<MeetingSession> {
        const { store } = await getStore();
        return store.startMeeting(topic, initiator);
    },

    /**
     * Get a meeting by ID
     */
    async getMeeting(id: string): Promise<MeetingSession | null> {
        const { store } = await getStore();
        return store.getMeeting(id);
    },

    /**
     * Add a message to a meeting
     */
    async addMessage(meetingId: string, message: DiscussionMessage): Promise<void> {
        const { store } = await getStore();
        return store.addMessage(meetingId, message);
    },

    /**
     * End a meeting
     */
    async endMeeting(meetingId: string, summary?: string, callerId?: string): Promise<{ meeting: MeetingSession; suggestedSyncTargets: string[] }> {
        const { store } = await getStore();
        return store.endMeeting(meetingId, summary, callerId);
    },

    /**
     * Archive a meeting
     */
    async archiveMeeting(meetingId: string, callerId?: string): Promise<void> {
        const { store } = await getStore();
        return store.archiveMeeting(meetingId, callerId);
    },

    /**
     * List meetings
     */
    async listMeetings(status?: MeetingStatus): Promise<Array<{
        id: string;
        topic: string;
        status: MeetingStatus;
        startTime: string;
        participantCount: number;
    }>> {
        const { store } = await getStore();
        return store.listMeetings(status);
    },

    /**
     * Get the current active meeting
     */
    async getActiveMeeting(): Promise<MeetingSession | null> {
        const { store } = await getStore();
        return store.getActiveMeeting();
    },

    /**
     * Get recent messages
     */
    async getRecentMessages(count?: number, meetingId?: string): Promise<DiscussionMessage[]> {
        const { store } = await getStore();
        return store.getRecentMessages(count || 10, meetingId);
    },

    /**
     * Get the current backend type
     */
    async getBackendType(): Promise<"sqlite" | "json"> {
        const { type } = await getStore();
        return type;
    },

    /**
     * Get meeting state (SQLite only, returns empty for JSON)
     */
    async getState(): Promise<{ activeMeetings: string[]; defaultMeetingId: string | null }> {
        const { type, store } = await getStore();
        if (type === "sqlite") {
            const sqliteStore = store as typeof SqliteStore;
            const activeMeetings = JSON.parse(sqliteStore!.getState("active_meetings") || "[]");
            const defaultMeetingId = sqliteStore!.getState("default_meeting") || null;
            return { activeMeetings, defaultMeetingId };
        } else {
            // JSON backend
            const jsonStore = store as typeof JsonStore;
            const state = await jsonStore!.getState();
            return state;
        }
    },

    /**
     * Get storage info for status display
     * @returns storage_mode and is_degraded flag
     */
    async getStorageInfo(): Promise<{ storage_mode: "sqlite" | "json"; is_degraded: boolean }> {
        const { type } = await getStore();
        return {
            storage_mode: type,
            is_degraded: type === "json"  // JSON mode is considered degraded
        };
    }
};
