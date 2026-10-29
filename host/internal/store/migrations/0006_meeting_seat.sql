-- The user's seat in a meeting and limits on stances (owned by internal/core).

-- seat_member_id: the session that holds the user's seat, NULL in a meeting
-- without one. Once set it is only handed to another session, never cleared,
-- so a meeting that had a seat keeps the seat's rules after the seat session
-- went offline or was cleaned up. consensus_draft: in a meeting with a seat,
-- the table id of the current draft while every required approver besides the
-- seat endorses it (the AI consensus last announced), else NULL.
ALTER TABLE meetings ADD COLUMN seat_member_id TEXT;
ALTER TABLE meetings ADD COLUMN consensus_draft INTEGER;

-- changes: how often the member changed its stance on the proposal (limited).
-- withdrawn: the stance was withdrawn; the row stays so that the stance it
-- had and the changes are kept.
ALTER TABLE meeting_stances ADD COLUMN changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_stances ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1));
