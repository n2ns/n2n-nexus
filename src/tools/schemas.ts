import { z } from "zod";
import {
    RegisterSessionSchema,
    SyncProjectAssetsSchema,
    UploadAssetSchema,
    TopologySchema,
    SearchProjectsSchema,
    SendMessageSchema,
    ReadMessagesSchema,
    UpdateStrategySchema,
    SyncGlobalDocSchema,
    UpdateProjectSchema,
    RenameProjectSchema,
    HostMaintenanceSchema,
    StartMeetingSchema,
    EndMeetingSchema,
    ArchiveMeetingSchema,
    ReopenMeetingSchema,
    CreateTaskSchema,
    GetTaskSchema,
    ListTasksSchema,
    UpdateTaskSchema,
    CancelTaskSchema,
    RemoveProjectSchema
} from "./schemas/index.js";

// Re-export common schemas used by other modules
export { ProjectIdSchema, FileNameSchema } from "./schemas/index.js";

/**
 * Tool Registry with descriptions and schemas
 */
export const TOOL_REGISTRY: Record<string, { description: string; schema: z.ZodTypeAny }> = {
    // --- Session & Context ---
    register_session_context: {
        description: "Register current workspace session. Use this to bind subsequent tool calls to a specific project. [Stateful]",
        schema: RegisterSessionSchema
    },

    // --- Project Assets ---
    sync_project_assets: {
        description: "[ASYNC] Synchronize project manifest and internal docs. Validates local path existence. Returns task ID. [Host only RECOMMENDED]",
        schema: SyncProjectAssetsSchema
    },
    upload_project_asset: {
        description: "Upload a binary or text asset (base64) to the current project's asset directory.",
        schema: UploadAssetSchema
    },

    // --- Discovery & Knowledge ---
    get_global_topology: {
        description: "Retrieve project graph and cross-project relations. Supports progressive loading via optional projectId.",
        schema: TopologySchema
    },
    search_projects: {
        description: "Search project registry by name or description. Use this instead of reading the full registry.",
        schema: SearchProjectsSchema
    },

    // --- Global Discussion & Strategy ---
    send_message: {
        description: "Send a message to the Nexus Hub or active meeting. Auto-routes based on session context.",
        schema: SendMessageSchema
    },
    read_messages: {
        description: "Read recent messages from global hub or specific meeting. Default count=10.",
        schema: ReadMessagesSchema
    },
    update_global_strategy: {
        description: "Update the shared collaboration strategy document.",
        schema: UpdateStrategySchema
    },
    sync_global_doc: {
        description: "Sync a specialized global document (e.g., guidelines, shared specs).",
        schema: SyncGlobalDocSchema
    },

    // --- Advanced Project Ops ---
    update_project: {
        description: "Patch project metadata in registry (description, techStack, etc). Cannot change ID.",
        schema: UpdateProjectSchema
    },
    rename_project: {
        description: "[ASYNC] Rename a project ID with automatic cascading updates to all relation references. Returns task ID.",
        schema: RenameProjectSchema
    },
    host_delete_project: {
        description: "[HOST ONLY] [ASYNC] Completely remove a project from registry and disk. Irreversible. Returns task ID.",
        schema: RemoveProjectSchema
    },
    host_maintenance: {
        description: "[HOST ONLY] Manage global discussion logs. 'prune' removes the oldest N entries. 'clear' wipes all logs. Irreversible.",
        schema: HostMaintenanceSchema
    },

    // --- Meeting Management ---
    start_meeting: {
        description: "Start a project-specific collaboration session (meeting). Sets context for subsequent messages.",
        schema: StartMeetingSchema
    },
    end_meeting: {
        description: "Close an active meeting and archive its summary. Optional manual summary override.",
        schema: EndMeetingSchema
    },
    archive_meeting: {
        description: "Move a closed meeting to archives. [Admin/Initiator only].",
        schema: ArchiveMeetingSchema
    },
    reopen_meeting: {
        description: "Reopen a closed or archived meeting. [Open to all participants].",
        schema: ReopenMeetingSchema
    },

    // --- Task Management (Phase 2) ---
    create_task: {
        description: "[ASYNC] Create a new background task. Returns task ID for polling. Link to meeting for traceability.",
        schema: CreateTaskSchema
    },
    get_task: {
        description: "Poll current status and progress of a background task.",
        schema: GetTaskSchema
    },
    list_tasks: {
        description: "List background tasks across the system. Support status filtering.",
        schema: ListTasksSchema
    },
    update_task: {
        description: "Update task progress or mark as finished (Internal use only).",
        schema: UpdateTaskSchema
    },
    cancel_task: {
        description: "[ASYNC] Cancel a pending or running task.",
        schema: CancelTaskSchema
    }
};
