-- Projects, documents, meetings, chat, events and tasks (owned by internal/core).

-- One row per project: the manifest's scalar fields as columns, its nested
-- values as JSON, its internal docs as text. position keeps the order projects
-- are listed in (a rename moves the project to the end).
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tech_stack TEXT NOT NULL,             -- JSON array of strings
    repository_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    endpoints TEXT NOT NULL,              -- JSON array of {name, url, description}
    api_spec TEXT NOT NULL,               -- JSON array of {method, path, summary}
    billing TEXT,                         -- JSON {plain, price} or NULL
    api_dependencies TEXT,                -- JSON object or NULL
    gateway_compatibility TEXT,
    api_versions TEXT,                    -- JSON object or NULL
    feature_tier TEXT CHECK (feature_tier IN ('standard', 'advanced', 'team')),
    internal_docs TEXT NOT NULL DEFAULT '',
    last_updated TEXT NOT NULL,           -- the manifest's lastUpdated
    last_active TEXT NOT NULL             -- last sync / update
);

-- A project's relations in manifest order. target_id has no foreign key: a
-- relation may name a project that does not exist (yet, or any more); a rename
-- rewrites the targets explicitly.
CREATE TABLE project_relations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
    position INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('dependency', 'parent', 'child', 'related')),
    PRIMARY KEY (project_id, position)
);
CREATE INDEX idx_project_relations_target ON project_relations(target_id);

CREATE TABLE project_assets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, file_name)
);

CREATE TABLE global_strategy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    updated_at TEXT
);
INSERT INTO global_strategy (id, content) VALUES (1, '# Global Coordination Blueprint

Shared meeting space.');

CREATE TABLE global_docs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- is_default marks the meeting send_message and end_meeting use without a
-- meetingId (always an active one); active_order is the order meetings became
-- active, so ending the default one hands the role to the latest still active.
-- current_proposal_id: the table id (meeting_messages.id) of the draft that
-- waits for approval, set only by publishing a draft (send_message draft);
-- approvers_version counts the changes of its approver list. end_reason:
-- 'consensus' when every required approver endorsed the draft, 'manual' when
-- end_meeting closed it. draft_reminded_at: when the draft's author was told
-- who has not taken a stance yet (once per draft).
CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    active_order INTEGER NOT NULL,
    initiator TEXT NOT NULL,
    participants TEXT NOT NULL,           -- JSON array of instance ids
    created_at TEXT NOT NULL,
    closed_at TEXT,
    summary TEXT,
    current_proposal_id INTEGER,
    approvers_version INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT CHECK (end_reason IN ('manual', 'consensus')),
    draft_reminded_at TEXT,
    CHECK (is_default = 0 OR status = 'active')
);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE UNIQUE INDEX idx_meetings_default ON meetings(is_default) WHERE is_default = 1;

-- seq numbers a meeting's messages from 1; tools show and take it as the
-- message id, while the table id still orders messages and keeps read cursors.
CREATE TABLE meeting_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK (category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL
);
CREATE INDEX idx_meeting_messages_meeting ON meeting_messages(meeting_id, id);
CREATE UNIQUE INDEX idx_meeting_messages_seq ON meeting_messages(meeting_id, seq);

-- Who takes part in a meeting (written here, notified by internal/agents): a
-- conversation session key (claude:<id> / codex:<id>), or an adapter instance
-- id for a client without hooks, which cannot be notified; identity_kind says
-- which, since a custom adapter id may look like a session id. mode: active
-- members are woken by new messages of others, async members see them at
-- their next hook. approver: whether the member's approval is required for a
-- decision. draft_eligible: the member joined before the current draft was
-- published, so it may approve it. notified_id is the table id of the newest
-- meeting message announced to the member (at join: the newest message then);
-- wakes and last_woken_at count the wakes the meeting caused. left_at is set
-- by leave_meeting; a member that left is not notified.
CREATE TABLE meeting_members (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('session', 'instance')),
    mode TEXT NOT NULL CHECK (mode IN ('active', 'async')),
    approver TEXT NOT NULL CHECK (approver IN ('required', 'optional')),
    draft_eligible INTEGER NOT NULL DEFAULT 0 CHECK (draft_eligible IN (0, 1)),
    joined_at TEXT NOT NULL,
    left_at TEXT,
    notified_id INTEGER NOT NULL DEFAULT 0,
    wakes INTEGER NOT NULL DEFAULT 0,
    last_woken_at TEXT,
    PRIMARY KEY (meeting_id, member_id)
);
CREATE INDEX idx_meeting_members_member ON meeting_members(member_id, left_at);

-- The required approvers of a meeting's current draft: the conversation
-- sessions that were required members when it was published, changed only by
-- an explicit leave or approver change. reminded_at: when the approver was
-- reminded of its missing stance (once per draft).
CREATE TABLE meeting_approvers (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    reminded_at TEXT,
    PRIMARY KEY (meeting_id, member_id)
);

-- Stances on proposals (message_id: the table id of a PROPOSAL message). A
-- member has one stance per proposal and may change or withdraw it.
CREATE TABLE meeting_stances (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('session', 'instance')),
    stance TEXT NOT NULL CHECK (stance IN ('endorse', 'object')),
    note TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, message_id, member_id)
);

CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
);
CREATE INDEX idx_decisions_meeting ON decisions(meeting_id);

-- AUTOINCREMENT: ids are never reused after a prune or clear, so read cursors stay valid.
CREATE TABLE global_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK (category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT                           -- JSON object or NULL
);
CREATE INDEX idx_events_action ON events(action);
CREATE INDEX idx_events_timestamp ON events(timestamp);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    progress REAL NOT NULL DEFAULT 0.0 CHECK (progress >= 0.0 AND progress <= 1.0),
    source_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    metadata TEXT,                        -- JSON object or NULL
    result_uri TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl INTEGER                           -- milliseconds
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_meeting ON tasks(source_meeting_id);

-- Last message each instance has read, per context ('global' / 'global' or 'meeting' / meeting id).
CREATE TABLE read_cursors (
    instance_id TEXT NOT NULL,
    context_type TEXT NOT NULL CHECK (context_type IN ('meeting', 'global')),
    context_id TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, context_type, context_id)
);
