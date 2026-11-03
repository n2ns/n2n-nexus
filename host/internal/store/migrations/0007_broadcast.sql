-- Broadcasts (owned by internal/agents).

-- A broadcast is written as one direct message per recipient, all with the
-- same broadcast_id; NULL for a message sent with send or reply.
-- broadcast_project: the working directory the broadcast was limited to
-- (sessions in it or below it), NULL when it went to every online session.
ALTER TABLE agent_messages ADD COLUMN broadcast_id TEXT;
ALTER TABLE agent_messages ADD COLUMN broadcast_project TEXT;
