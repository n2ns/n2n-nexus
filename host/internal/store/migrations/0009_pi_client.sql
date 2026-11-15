-- The pi CLI as a client (owned by internal/agents).

-- agent_sessions.client gains 'pi'. SQLite cannot change a CHECK constraint,
-- so the table is rebuilt; foreign keys are off while migrating, and the
-- tables that refer to agent_sessions keep their references by name.
CREATE TABLE agent_sessions_new (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex', 'pi')),
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
    environment TEXT NOT NULL DEFAULT ''
);
INSERT INTO agent_sessions_new (id, client, name, note, cwd, status, listening, created_at, last_active_at,
    title, title_source, hostname, platform, utc_offset, label, environment)
    SELECT id, client, name, note, cwd, status, listening, created_at, last_active_at,
    title, title_source, hostname, platform, utc_offset, label, environment FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
CREATE INDEX idx_agent_sessions_name ON agent_sessions(name);

-- The session each pi process runs: the pi extension names its process ID in
-- each hook event, and a tool call (which carries no session of its own,
-- unlike Claude Code's and Codex's) names the processes above the MCP adapter
-- that pi started, so the nearest one listed here is its pi process. machine
-- is hostname, platform and environment joined by newlines: process IDs are
-- per machine. Each hook event of the process replaces its row.
CREATE TABLE pi_client_pids (
    machine TEXT NOT NULL,
    client_pid INTEGER NOT NULL,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (machine, client_pid)
);
