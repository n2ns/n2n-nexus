-- Keep expiry distinct from SessionEnd across host restarts. Only a session
-- that expired while idle may resume through a background wait. Existing
-- offline sessions have no known expiry reason and require real activity.
ALTER TABLE agent_sessions ADD COLUMN stale_from TEXT NOT NULL DEFAULT ''
    CHECK (stale_from IN ('', 'idle', 'working'));
