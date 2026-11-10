-- Every direct message may wake its recipient: the sender no longer decides,
-- so agent_messages loses its wake column. A broadcast delivery keeps its own
-- (wake = 1 only when the session was listening when it was sent).
DROP VIEW agent_inbox;
ALTER TABLE agent_messages DROP COLUMN wake;

-- As in 0007, with wake = 1 for every direct message.
CREATE VIEW agent_inbox AS
    SELECT 'direct' AS kind, m.id, m.from_id, m.to_id, m.text,
           COALESCE(m.reply_to, m.reply_to_broadcast) AS reply_to,
           CASE WHEN m.reply_to IS NOT NULL THEN 'direct' WHEN m.reply_to_broadcast IS NOT NULL THEN 'broadcast' END AS reply_kind,
           NULL AS scope, m.status, m.created_at, m.expires_at, m.notified_at, m.read_at, m.expects_reply, 1 AS wake, m.rowid AS seq
    FROM agent_messages m
    UNION ALL
    SELECT 'broadcast', b.id, b.from_id, d.to_id, b.text, NULL, NULL, b.project, d.status, b.created_at, b.expires_at,
           d.notified_at, d.read_at, b.expects_reply, d.wake, d.rowid
    FROM broadcast_deliveries d JOIN broadcasts b ON b.id = d.broadcast_id;
