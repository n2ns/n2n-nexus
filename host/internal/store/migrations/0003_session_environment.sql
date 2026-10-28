-- The environment of a session's machine (owned by internal/agents).

-- environment tells environments that share a host name apart (the WSL
-- distribution); '' when there is no such thing. Every hook event reports it.
ALTER TABLE agent_sessions ADD COLUMN environment TEXT NOT NULL DEFAULT '';
