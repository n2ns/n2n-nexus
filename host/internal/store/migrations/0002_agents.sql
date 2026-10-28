-- Agent sessions and direct messages between conversations (owned by internal/agents).

-- One session per Claude Code / Codex conversation, created by the client hooks.
-- title: what the conversation is called, for display only (name stays the
-- handle send takes). title_source: 'client' when the client's hook reported
-- it, 'self' when the session set it with set_profile (the client's title no
-- longer replaces it), '' when there is none. hostname, platform and
-- utc_offset (local time minus UTC, in minutes) are where the conversation
-- runs, as every hook event reports it; label is a short machine name the
-- session set itself, shown in place of the hostname.
CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex')),
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
    label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_agent_sessions_name ON agent_sessions(name);

-- Direct messages between agent sessions. expects_reply = 0: the notification
-- says no reply is needed. wake = 0: the message never wakes the recipient or
-- holds its Stop; it is announced at the recipient's next prompt or tool call.
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES agent_sessions(id),
    to_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    reply_to TEXT REFERENCES agent_messages(id),
    status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    notified_at TEXT,
    read_at TEXT,
    expects_reply INTEGER NOT NULL CHECK (expects_reply IN (0, 1)),
    wake INTEGER NOT NULL CHECK (wake IN (0, 1))
);
CREATE INDEX idx_agent_messages_inbox ON agent_messages(to_id, status);
CREATE INDEX idx_agent_messages_expiry ON agent_messages(status, expires_at);

-- Notices for a session (idle subscriptions, expired messages, meetings),
-- delivered by hooks. meeting_id: the meeting a notice comes from, or NULL: a
-- meeting notice is no direct message and does not count as an automatic turn.
CREATE TABLE agent_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    notified_at TEXT,
    meeting_id TEXT
);
CREATE INDEX idx_agent_notices_pending ON agent_notices(session_id, notified_at);

-- One-shot "tell me when the target finishes its turn" subscriptions.
CREATE TABLE agent_idle_subscriptions (
    subscriber_id TEXT NOT NULL REFERENCES agent_sessions(id),
    target_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, target_id)
);
CREATE INDEX idx_agent_idle_target ON agent_idle_subscriptions(target_id);

-- Claude toolUseId -> session, written by the PreToolUse hook.
CREATE TABLE tool_use_bindings (
    tool_use_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_use_bindings_created ON tool_use_bindings(created_at);

-- Adapter instances that make chat or meeting calls as a hooked conversation:
-- a call from such an instance whose conversation cannot be resolved fails
-- instead of acting as the instance, until the instance has resolved no
-- conversation for the stale-session window (its hooks were removed).
CREATE TABLE hooked_instances (
    instance_id TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
);
