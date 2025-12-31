import { z } from "zod";

/**
 * Project ID validation regex based on Nexus conventions.
 */
export const ProjectIdSchema = z.string()
    .describe("Strict flat identifier. MUST start with a type-prefix followed by an underscore.")
    .refine(val => {
        const validPrefixes = ["web_", "api_", "chrome_", "vscode_", "mcp_", "android_", "ios_", "flutter_", "desktop_", "lib_", "bot_", "infra_", "doc_"];
        return validPrefixes.some(p => val.startsWith(p));
    }, "Project ID must start with a valid prefix (e.g., 'web_', 'api_')")
    .refine(val => !val.includes("..") && !val.includes("/") && !val.includes("\\"), "Project ID cannot contain '..' or slashes.");

/**
 * 1. register_session_context
 */
export const RegisterSessionSchema = z.object({
    projectId: ProjectIdSchema
});

/**
 * 2. sync_project_assets
 */
export const SyncProjectAssetsSchema = z.object({
    manifest: z.object({
        id: ProjectIdSchema,
        name: z.string(),
        description: z.string(),
        techStack: z.array(z.string()),
        relations: z.array(z.object({
            targetId: z.string(),
            type: z.enum(["dependency", "parent", "child", "related"])
        })),
        lastUpdated: z.string().describe("ISO timestamp"),
        repositoryUrl: z.string(),
        localPath: z.string().describe("Physical disk path"),
        endpoints: z.array(z.object({
            name: z.string(),
            url: z.string(),
            description: z.string()
        })),
        apiSpec: z.array(z.object({
            method: z.string(),
            path: z.string(),
            summary: z.string()
        }))
    }),
    internalDocs: z.string().describe("Mandatory technical implementation guide (Markdown)")
});

/**
 * Safe file name validation (no path traversal)
 */
export const FileNameSchema = z.string()
    .min(1, "File name cannot be empty")
    .max(255, "File name too long")
    .refine(val => !val.includes("/") && !val.includes("\\"), "File name cannot contain slashes")
    .refine(val => !val.includes(".."), "File name cannot contain '..'")
    .refine(val => !val.startsWith("."), "File name cannot start with '.'")
    .describe("Safe file name without path components");

/**
 * 3. upload_project_asset
 */
export const UploadAssetSchema = z.object({
    fileName: FileNameSchema,
    base64Content: z.string()
});

/**
 * 4. get_global_topology (No arguments)
 */
export const EmptySchema = z.object({});


/**
 * 7. send_message
 */
export const SendMessageSchema = z.object({
    message: z.string().min(1, "Message cannot be empty"),
    category: z.enum(["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT"]).optional()
});

/**
 * 8. read_messages
 */
export const ReadMessagesSchema = z.object({
    count: z.number().int().positive().optional().default(10),
    meetingId: z.string().optional()
});

/**
 * 9. update_global_strategy
 */
export const UpdateStrategySchema = z.object({
    content: z.string().min(1, "Strategy content cannot be empty")
});

/**
 * 10. sync_global_doc
 */
export const SyncGlobalDocSchema = z.object({
    docId: z.string(),
    title: z.string(),
    content: z.string()
});


/**
 * 13. update_project
 */
export const UpdateProjectSchema = z.object({
    projectId: ProjectIdSchema,
    patch: z.object({}).passthrough().describe("Fields to update (e.g., description, techStack)")
});

/**
 * 14. rename_project
 */
export const RenameProjectSchema = z.object({
    oldId: ProjectIdSchema,
    newId: ProjectIdSchema
});

/**
 * 15. moderator_maintenance
 */
export const ModeratorMaintenanceSchema = z.object({
    action: z.enum(["prune", "clear"]),
    count: z.number().int().min(0)
});

/**
 * 16. moderator_delete_project
 */
export const ModeratorDeleteSchema = z.object({
    projectId: ProjectIdSchema
});

/**
 * 17. start_meeting
 */
export const StartMeetingSchema = z.object({
    topic: z.string().min(1, "Topic is required")
});

/**
 * 18. end_meeting
 */
export const EndMeetingSchema = z.object({
    meetingId: z.string().optional(),
    summary: z.string().optional()
});



/**
 * 21. archive_meeting
 */
export const ArchiveMeetingSchema = z.object({
    meetingId: z.string()
});

/**
 * 22. reopen_meeting
 */
export const ReopenMeetingSchema = z.object({
    meetingId: z.string()
});

// ============ Phase 2: Task Management Schemas ============

/**
 * 22. create_task
 */
export const CreateTaskSchema = z.object({
    source_meeting_id: z.string().optional().describe("Link task to a meeting for traceability"),
    metadata: z.object({}).passthrough().optional().describe("Custom task parameters"),
    ttl: z.number().int().positive().optional().describe("Time-to-live in milliseconds")
});

/**
 * 23. get_task
 */
export const GetTaskSchema = z.object({
    taskId: z.string()
});

/**
 * 24. list_tasks
 */
export const ListTasksSchema = z.object({
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    limit: z.number().int().positive().optional().default(50)
});

/**
 * 25. update_task
 */
export const UpdateTaskSchema = z.object({
    taskId: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    progress: z.number().min(0).max(1).optional(),
    result_uri: z.string().optional(),
    error_message: z.string().optional()
});

/**
 * 26. cancel_task
 */
export const CancelTaskSchema = z.object({
    taskId: z.string()
});

/**
 * Tool Registry with descriptions and schemas
 */
export const TOOL_REGISTRY: Record<string, { description: string; schema: z.ZodTypeAny }> = {
    register_session_context: {
        description: "[IDENTITY] Declare the PROJECT identity. Format: [prefix]_[technical-identifier]. (e.g., 'web_datafrog.io', 'mcp_nexus-core').",
        schema: RegisterSessionSchema
    },
    sync_project_assets: {
        description: "CRITICAL: [PREREQUISITE: register_session_context] Sync full project state. Both manifest and documentation are MANDATORY.",
        schema: SyncProjectAssetsSchema
    },
    upload_project_asset: {
        description: "Upload a binary file (images, PDFs, etc.) to the current project's asset folder. Requires active session (call register_session_context first). Returns the relative path of the saved file.",
        schema: UploadAssetSchema
    },
    get_global_topology: {
        description: "Retrieve complete project relationship graph. Returns { nodes: [{ id, name }], edges: [{ from, to, type }] }. Use this to visualize dependencies.",
        schema: EmptySchema
    },
    send_message: {
        description: "Post a message to the Nexus collaboration space. If an active meeting exists, the message is automatically routed to that meeting. Otherwise, it goes to the global discussion log. Use this for proposals, decisions, or general coordination.",
        schema: SendMessageSchema
    },
    read_messages: {
        description: "Read recent messages. Automatically reads from the active meeting if one exists, otherwise reads from global logs.",
        schema: ReadMessagesSchema
    },
    update_global_strategy: {
        description: "Overwrite master strategy. Content is MANDATORY.",
        schema: UpdateStrategySchema
    },
    sync_global_doc: {
        description: "Create or update a global document. Returns the document ID.",
        schema: SyncGlobalDocSchema
    },
    update_project: {
        description: "Partially update a project's manifest. Only provided fields will be updated.",
        schema: UpdateProjectSchema
    },
    rename_project: {
        description: "[ASYNC] Rename a project ID with automatic cascading updates to all relation references. Returns task ID.",
        schema: RenameProjectSchema
    },
    moderator_maintenance: {
        description: "[ADMIN ONLY] Manage global discussion logs. 'prune' removes the oldest N entries (keeps newest). 'clear' wipes all logs (use count=0). Returns summary of removed entries. Irreversible.",
        schema: ModeratorMaintenanceSchema
    },
    moderator_delete_project: {
        description: "[ASYNC][ADMIN ONLY] Completely remove a project, its manifest, and all its assets from Nexus Hub. Returns task ID. Irreversible.",
        schema: ModeratorDeleteSchema
    },
    start_meeting: {
        description: "Start a new meeting session. Creates a dedicated file for the meeting. Returns the meeting ID and details.",
        schema: StartMeetingSchema
    },
    end_meeting: {
        description: "End an active meeting. Locks the session for further messages. [RESTRICTED: Only moderator can end].",
        schema: EndMeetingSchema
    },
    archive_meeting: {
        description: "Archive a closed meeting. Archived meetings are read-only and excluded from active queries. [RESTRICTED: Only moderator can archive].",
        schema: ArchiveMeetingSchema
    },
    reopen_meeting: {
        description: "Reopen a closed or archived meeting. [Open to all participants].",
        schema: ReopenMeetingSchema
    },
    // --- Phase 2: Task Management ---
    create_task: {
        description: "[ASYNC] Create a new background task. Returns task ID for polling. Link to meeting for traceability.",
        schema: CreateTaskSchema
    },
    get_task: {
        description: "[ASYNC] Get the status and progress of a task by ID.",
        schema: GetTaskSchema
    },
    list_tasks: {
        description: "[ASYNC] List all tasks with optional status filter.",
        schema: ListTasksSchema
    },
    update_task: {
        description: "[ASYNC][INTERNAL] Update task status, progress, or result. Intended for background workers only - do not call directly from user-facing tools.",
        schema: UpdateTaskSchema
    },
    cancel_task: {
        description: "[ASYNC] Cancel a pending or running task.",
        schema: CancelTaskSchema
    },
};
