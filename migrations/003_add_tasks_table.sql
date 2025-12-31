-- Phase 2: Task Primitive System
-- Migration: 003_add_tasks_table.sql
-- Created: 2025-12-31

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'pending',
    progress REAL DEFAULT 0.0 CHECK(progress >= 0.0 AND progress <= 1.0),
    source_meeting_id TEXT,
    metadata TEXT,  -- JSON: stores task parameters, context, client-specific fields
    result_uri TEXT,  -- Resource URI for completed task output
    error_message TEXT,  -- Diagnostic info on failure
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ttl INTEGER,  -- Time-to-live in milliseconds
    FOREIGN KEY (source_meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
);

-- Index for efficient status-based queries (polling)
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Index for meeting-to-task traceability
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(source_meeting_id);

-- Trigger to auto-update updated_at on modification
CREATE TRIGGER IF NOT EXISTS tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;
