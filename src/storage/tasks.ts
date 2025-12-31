/**
 * TaskService - Phase 2: Async Task Management
 * 
 * Manages long-running operations with progress tracking, 
 * meeting traceability, and MCP-compatible status reporting.
 */
import { getDatabase } from "./sqlite.js";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Task {
    id: string;
    status: TaskStatus;
    progress: number;  // 0.0 - 1.0
    source_meeting_id: string | null;
    metadata: Record<string, unknown>;
    result_uri: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    ttl: number | null;  // milliseconds
}

export interface CreateTaskInput {
    id?: string;
    source_meeting_id?: string;
    metadata?: Record<string, unknown>;
    ttl?: number;
}

export interface TaskUpdate {
    status?: TaskStatus;
    progress?: number;
    result_uri?: string;
    error_message?: string;
    metadata?: Record<string, unknown>;
}

// Generate unique task ID
function generateTaskId(): string {
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const random = Math.random().toString(36).substring(2, 6);
    return `task_${timestamp}_${random}`;
}

/**
 * Initialize the tasks table (run migrations)
 */
export function initTasksTable(): void {
    const db = getDatabase();

    const TASKS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'pending',
        progress REAL DEFAULT 0.0 CHECK(progress >= 0.0 AND progress <= 1.0),
        source_meeting_id TEXT,
        metadata TEXT,
        result_uri TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        ttl INTEGER,
        FOREIGN KEY (source_meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(source_meeting_id);
    `;

    db.exec(TASKS_SCHEMA);

    // Add trigger for auto-updating updated_at (separate exec to handle IF NOT EXISTS)
    try {
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS tasks_updated_at
            AFTER UPDATE ON tasks
            FOR EACH ROW
            BEGIN
                UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
            END;
        `);
    } catch {
        // Trigger may already exist in older SQLite versions without IF NOT EXISTS support
    }

    console.error("[Nexus] Tasks table initialized");
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput = {}): Task {
    const db = getDatabase();
    const id = input.id || generateTaskId();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
        INSERT INTO tasks (id, status, progress, source_meeting_id, metadata, created_at, updated_at, ttl)
        VALUES (?, 'pending', 0.0, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        input.source_meeting_id || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
        input.ttl || null
    );

    return getTask(id)!;
}

/**
 * Get a task by ID
 */
export function getTask(id: string): Task | null {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
        id: row.id as string,
        status: row.status as TaskStatus,
        progress: row.progress as number,
        source_meeting_id: (row.source_meeting_id as string) || null,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
        result_uri: (row.result_uri as string) || null,
        error_message: (row.error_message as string) || null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        ttl: (row.ttl as number) || null
    };
}

/**
 * Update task status and progress
 */
export function updateTask(id: string, update: TaskUpdate): Task | null {
    const db = getDatabase();
    const now = new Date().toISOString();

    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (update.status !== undefined) {
        sets.push("status = ?");
        values.push(update.status);
    }
    if (update.progress !== undefined) {
        sets.push("progress = ?");
        values.push(Math.max(0, Math.min(1, update.progress)));
    }
    if (update.result_uri !== undefined) {
        sets.push("result_uri = ?");
        values.push(update.result_uri);
    }
    if (update.error_message !== undefined) {
        sets.push("error_message = ?");
        values.push(update.error_message);
    }
    if (update.metadata !== undefined) {
        sets.push("metadata = ?");
        values.push(JSON.stringify(update.metadata));
    }

    values.push(id);

    const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...values);

    return getTask(id);
}

/**
 * List tasks with optional status filter
 */
export function listTasks(status?: TaskStatus, limit: number = 50): Task[] {
    const db = getDatabase();

    let sql = "SELECT * FROM tasks";
    const params: unknown[] = [];

    if (status) {
        sql += " WHERE status = ?";
        params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

    return rows.map(row => ({
        id: row.id as string,
        status: row.status as TaskStatus,
        progress: row.progress as number,
        source_meeting_id: (row.source_meeting_id as string) || null,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
        result_uri: (row.result_uri as string) || null,
        error_message: (row.error_message as string) || null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        ttl: (row.ttl as number) || null
    }));
}

/**
 * Get tasks by meeting ID
 */
export function getTasksByMeeting(meetingId: string): Task[] {
    const db = getDatabase();
    const rows = db.prepare(`
        SELECT * FROM tasks WHERE source_meeting_id = ? ORDER BY created_at DESC
    `).all(meetingId) as Record<string, unknown>[];

    return rows.map(row => ({
        id: row.id as string,
        status: row.status as TaskStatus,
        progress: row.progress as number,
        source_meeting_id: (row.source_meeting_id as string) || null,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
        result_uri: (row.result_uri as string) || null,
        error_message: (row.error_message as string) || null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        ttl: (row.ttl as number) || null
    }));
}

/**
 * Cancel a pending or running task
 */
export function cancelTask(id: string): boolean {
    const task = getTask(id);
    if (!task) return false;
    if (task.status !== "pending" && task.status !== "running") return false;

    updateTask(id, { status: "cancelled" });
    return true;
}

/**
 * Delete completed/failed/cancelled tasks older than specified age
 */
export function cleanupTasks(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const result = db.prepare(`
        DELETE FROM tasks 
        WHERE status IN ('completed', 'failed', 'cancelled') 
        AND updated_at < ?
    `).run(cutoff);

    return result.changes;
}

/**
 * Get active (pending/running) task count
 */
export function getActiveTaskCount(): number {
    const db = getDatabase();
    const row = db.prepare(`
        SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'running')
    `).get() as { count: number };
    return row.count;
}
