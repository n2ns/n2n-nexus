// Package cursors keeps what a reader has read and has been told about in the
// tables core owns (read_cursors, meeting_members), for both core and agents.
package cursors

import "database/sql"

// Read moves reader's read cursor of a context ("meeting" or "global") to row;
// it never moves back.
func Read(tx *sql.Tx, reader, contextType, contextID string, row int64, now string) error {
	_, err := tx.Exec(`
		INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (instance_id, context_type, context_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at`,
		reader, contextType, contextID, row, now)
	return err
}

// Announced moves a meeting member's notified_id to row, so its next
// notification does not repeat what came up to it; it never moves back.
func Announced(tx *sql.Tx, meetingID, member string, row int64) error {
	_, err := tx.Exec(`UPDATE meeting_members SET notified_id = ? WHERE meeting_id = ? AND member_id = ? AND notified_id < ?`,
		row, meetingID, member, row)
	return err
}

// UnreadBefore counts the messages of others in a meeting after reader's read
// cursor (0 when it has none) and before row.
func UnreadBefore(tx *sql.Tx, meetingID, reader string, row int64) (int, error) {
	var n int
	err := tx.QueryRow(`SELECT COUNT(*) FROM meeting_messages WHERE meeting_id = ? AND sender != ? AND id < ?
		AND id > COALESCE((SELECT last_read_id FROM read_cursors WHERE instance_id = ? AND context_type = 'meeting' AND context_id = ?), 0)`,
		meetingID, reader, row, reader, meetingID).Scan(&n)
	return n, err
}
