-- Broadcasts (owned by internal/agents).

-- A broadcast is one notice to the sessions online when it was sent. Its text
-- and scope are stored once; each recipient has one delivery, keyed by the
-- broadcast's id, so the broadcast's id is also the id every recipient sees
-- and answers. project: the working directory it was limited to (sessions in
-- it or below it), NULL when it went to every online session.
CREATE TABLE broadcasts (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    project TEXT,
    expects_reply INTEGER NOT NULL CHECK (expects_reply IN (0, 1)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- A broadcast's delivery to one session. wake = 1 when the session was
-- listening when the broadcast was sent: only then may it wake the session or
-- hold its Stop. An expired delivery tells nobody.
CREATE TABLE broadcast_deliveries (
    broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
    to_id TEXT NOT NULL REFERENCES agent_sessions(id),
    status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'expired')),
    notified_at TEXT,
    read_at TEXT,
    wake INTEGER NOT NULL CHECK (wake IN (0, 1)),
    PRIMARY KEY (broadcast_id, to_id)
);
CREATE INDEX idx_broadcast_deliveries_inbox ON broadcast_deliveries(to_id, status);

-- reply_to_broadcast: the broadcast a direct message answers (reply_to is then NULL).
ALTER TABLE agent_messages ADD COLUMN reply_to_broadcast TEXT REFERENCES broadcasts(id);

-- What a session has received: its direct messages and its broadcast
-- deliveries, with the same columns. id is the message's or the broadcast's;
-- reply_kind says what reply_to names. seq orders items of the same time
-- within their kind.
CREATE VIEW agent_inbox AS
    SELECT 'direct' AS kind, m.id, m.from_id, m.to_id, m.text,
           COALESCE(m.reply_to, m.reply_to_broadcast) AS reply_to,
           CASE WHEN m.reply_to IS NOT NULL THEN 'direct' WHEN m.reply_to_broadcast IS NOT NULL THEN 'broadcast' END AS reply_kind,
           NULL AS scope, m.status, m.created_at, m.expires_at, m.notified_at, m.read_at, m.expects_reply, m.wake, m.rowid AS seq
    FROM agent_messages m
    UNION ALL
    SELECT 'broadcast', b.id, b.from_id, d.to_id, b.text, NULL, NULL, b.project, d.status, b.created_at, b.expires_at,
           d.notified_at, d.read_at, b.expects_reply, d.wake, d.rowid
    FROM broadcast_deliveries d JOIN broadcasts b ON b.id = d.broadcast_id;
