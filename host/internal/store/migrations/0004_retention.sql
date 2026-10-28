-- Retention of meetings and snapshots of who wrote what (owned by internal/core).

-- end_reason 'expired': an active meeting without a message for
-- meetingRetentionDays (counted from its last message, start or reopening)
-- was closed by the host. reopened_at: when reopen_meeting last made it
-- active. SQLite cannot change a CHECK, so the table is rebuilt (the
-- migration runs with foreign keys off).
CREATE TABLE meetings_new (
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
    end_reason TEXT CHECK (end_reason IN ('manual', 'consensus', 'expired')),
    draft_reminded_at TEXT,
    reopened_at TEXT,
    CHECK (is_default = 0 OR status = 'active')
);
INSERT INTO meetings_new SELECT id, topic, status, is_default, active_order, initiator, participants, created_at,
    closed_at, summary, current_proposal_id, approvers_version, end_reason, draft_reminded_at, NULL FROM meetings;
DROP TABLE meetings;
ALTER TABLE meetings_new RENAME TO meetings;
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE UNIQUE INDEX idx_meetings_default ON meetings(is_default) WHERE is_default = 1;

-- Who wrote a message or joined a meeting, as shown then: the session's name,
-- title (members) and machine ("<label or hostname> · <platform>[ <environment>]"),
-- NULL for an adapter instance. A session is deleted after it has been offline
-- for retentionDays, and these keep the records readable. snapshot_backfilled:
-- written when this migration ran, from the session as it was then, not when
-- the row was written.
ALTER TABLE meeting_messages ADD COLUMN sender_name TEXT;
ALTER TABLE meeting_messages ADD COLUMN sender_machine TEXT;
ALTER TABLE meeting_messages ADD COLUMN snapshot_backfilled INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_backfilled IN (0, 1));
ALTER TABLE global_messages ADD COLUMN sender_name TEXT;
ALTER TABLE global_messages ADD COLUMN sender_machine TEXT;
ALTER TABLE global_messages ADD COLUMN snapshot_backfilled INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_backfilled IN (0, 1));
ALTER TABLE meeting_members ADD COLUMN name TEXT;
ALTER TABLE meeting_members ADD COLUMN title TEXT;
ALTER TABLE meeting_members ADD COLUMN machine TEXT;
ALTER TABLE meeting_members ADD COLUMN snapshot_backfilled INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_backfilled IN (0, 1));

UPDATE meeting_messages SET snapshot_backfilled = 1,
    sender_name = (SELECT s.name FROM agent_sessions s WHERE s.id = meeting_messages.sender),
    sender_machine = (SELECT CASE WHEN s.label != '' THEN s.label ELSE s.hostname END || ' · ' ||
        CASE s.platform WHEN 'darwin' THEN 'macOS' WHEN 'linux' THEN 'Linux' WHEN 'wsl' THEN 'WSL' WHEN 'win32' THEN 'Windows' END ||
        CASE WHEN s.environment != '' THEN ' ' || s.environment ELSE '' END
        FROM agent_sessions s WHERE s.id = meeting_messages.sender)
    WHERE sender IN (SELECT id FROM agent_sessions);
UPDATE global_messages SET snapshot_backfilled = 1,
    sender_name = (SELECT s.name FROM agent_sessions s WHERE s.id = global_messages.sender),
    sender_machine = (SELECT CASE WHEN s.label != '' THEN s.label ELSE s.hostname END || ' · ' ||
        CASE s.platform WHEN 'darwin' THEN 'macOS' WHEN 'linux' THEN 'Linux' WHEN 'wsl' THEN 'WSL' WHEN 'win32' THEN 'Windows' END ||
        CASE WHEN s.environment != '' THEN ' ' || s.environment ELSE '' END
        FROM agent_sessions s WHERE s.id = global_messages.sender)
    WHERE sender IN (SELECT id FROM agent_sessions);
UPDATE meeting_members SET snapshot_backfilled = 1,
    name = (SELECT s.name FROM agent_sessions s WHERE s.id = meeting_members.member_id),
    title = (SELECT s.title FROM agent_sessions s WHERE s.id = meeting_members.member_id),
    machine = (SELECT CASE WHEN s.label != '' THEN s.label ELSE s.hostname END || ' · ' ||
        CASE s.platform WHEN 'darwin' THEN 'macOS' WHEN 'linux' THEN 'Linux' WHEN 'wsl' THEN 'WSL' WHEN 'win32' THEN 'Windows' END ||
        CASE WHEN s.environment != '' THEN ' ' || s.environment ELSE '' END
        FROM agent_sessions s WHERE s.id = meeting_members.member_id)
    WHERE member_id IN (SELECT id FROM agent_sessions);
