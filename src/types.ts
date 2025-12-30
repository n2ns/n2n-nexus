export interface ProjectManifest {
    id: string;
    name: string;
    description: string;
    techStack: string[];
    relations: { targetId: string; type: "dependency" | "parent" | "child" | "related" }[];
    billing?: { plain: string; price: string };
    lastUpdated: string;
    repositoryUrl: string;
    localPath: string; // Physical disk path of the project (required)
    endpoints: { name: string; url: string; description: string }[];
    apiSpec: { method: string; path: string; summary: string }[];

    // Schema v2.0 - Enhanced dependency tracking and versioning
    apiDependencies?: Record<string, string>; // Map of projectId to version constraint (e.g., ">=v2.1")
    gatewayCompatibility?: string; // Gateway version compatibility (e.g., ">=v2.1")
    api_versions?: Record<string, string>; // Feature-level API versions (e.g., "client_id_alias": "v3.6.20")
    feature_tier?: "free" | "pro" | "enterprise"; // Feature tier declaration for capability detection
}

export interface DiscussionMessage {
    timestamp: string;
    from: string;
    text: string;
    category?: "MEETING_START" | "PROPOSAL" | "DECISION" | "UPDATE" | "CHAT";
}

// Meeting Architecture Types (Phase 1)
export type MeetingStatus = "active" | "closed" | "archived";

export interface MeetingSession {
    id: string;                     // Format: YYYYMMDD-HHmmss-[topic-slug]
    topic: string;
    status: MeetingStatus;
    startTime: string;
    endTime?: string;
    initiator: string;              // The Agent ID who started the meeting
    participants: string[];         // List of Agent IDs who posted
    messages: DiscussionMessage[];
    decisions: string[];            // Extracted DECISION messages (per Daisy's request)
    summary?: string;               // Optional summary on close
}

export interface MeetingState {
    activeMeetings: string[];       // Stack of active meeting IDs
    defaultMeetingId: string | null; // Most recent active meeting (for auto-routing)
}

export interface HubConfig {
    instanceId: string;
    isModerator: boolean;
    rootStorage: string;
}

export interface Registry {
    projects: Record<string, {
        name?: string;
        summary: string;
        lastActive: string;
    }>;
}

export interface GlobalDocEntry {
    title: string;
    lastUpdated: string;
    updatedBy: string;
}

export type GlobalDocIndex = Record<string, GlobalDocEntry>;
