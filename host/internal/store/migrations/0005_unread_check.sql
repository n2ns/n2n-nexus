-- Reading before posting to a meeting (owned by internal/core).

-- send_refused: the reader's last send_message to this meeting was refused
-- because messages of others were unread; its next one goes through, with a
-- note of what was unread. Kept per reader rather than per member: a session
-- or instance that has not joined posts and is refused too.
ALTER TABLE read_cursors ADD COLUMN send_refused INTEGER NOT NULL DEFAULT 0 CHECK (send_refused IN (0, 1));
