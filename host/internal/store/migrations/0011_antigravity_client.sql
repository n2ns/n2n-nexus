-- Google Antigravity (the IDE and the agy CLI) as a client (owned by internal/agents).

-- agent_sessions.client gains 'antigravity'. SQLite cannot change a CHECK
-- constraint, so the table is rebuilt as in 0009, with stale_from from 0010;
-- foreign keys are off while migrating, and the tables that refer to
-- agent_sessions keep their references by name.
CREATE TABLE agent_sessions_new (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex', 'pi', 'antigravity')),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('working', 'idle', 'listening', 'offline')),
    listening INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT '' CHECK (title_source IN ('', 'client', 'self')),
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux', 'wsl', 'win32')),
    utc_offset INTEGER NOT NULL CHECK (utc_offset BETWEEN -1440 AND 1440),
    label TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL DEFAULT '',
    stale_from TEXT NOT NULL DEFAULT '' CHECK (stale_from IN ('', 'idle', 'working'))
);
INSERT INTO agent_sessions_new (id, client, name, note, cwd, status, listening, created_at, last_active_at,
    title, title_source, hostname, platform, utc_offset, label, environment, stale_from)
    SELECT id, client, name, note, cwd, status, listening, created_at, last_active_at,
    title, title_source, hostname, platform, utc_offset, label, environment, stale_from FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
CREATE INDEX idx_agent_sessions_name ON agent_sessions(name);
