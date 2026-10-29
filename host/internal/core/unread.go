package core

import (
	"database/sql"
	"fmt"

	"github.com/n2ns/n2n-nexus/host/internal/cursors"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
)

// Posting to a meeting, and taking a stance in it, need the messages of
// others read first: those after the caller's read cursor (read_cursors),
// whatever moved it (read_messages in unread mode, a notification that showed
// them whole, or an earlier refusal that attached them). History reads
// (latest, afterId) do not count. A refused call attaches the unread
// messages and counts them as read.

// unread is what a reader has not read of a meeting.
type unread struct {
	meetingID, reader string
	cursor            int64
	// refused: the reader's last send_message to the meeting was refused.
	refused bool
	// messages are the messages of others after the cursor, oldest first.
	messages []chatMessage
}

func loadUnread(tx *sql.Tx, meetingID, reader string) (unread, error) {
	u := unread{meetingID: meetingID, reader: reader}
	err := tx.QueryRow(`SELECT last_read_id, send_refused FROM read_cursors WHERE instance_id = ? AND context_type = 'meeting' AND context_id = ?`,
		reader, meetingID).Scan(&u.cursor, &u.refused)
	if err != nil && err != sql.ErrNoRows {
		return u, err
	}
	u.messages, err = sourceOf(meetingID).query(tx, "m.id > ? AND m.sender != ?", "ORDER BY m.id", u.cursor, reader)
	return u, err
}

// span is the numbers of the unread messages, as "#a–#b" or "#a".
func (u unread) span() string {
	first, last := u.messages[0].ID, u.messages[len(u.messages)-1].ID
	if first == last {
		return fmt.Sprintf("#%d", first)
	}
	return fmt.Sprintf("#%d–#%d", first, last)
}

// unreadMessage is a message attached to a refused call; Cut: its text was cut.
type unreadMessage struct {
	chatMessage
	Cut bool `json:"cut"`
}

// attach returns the unread messages for a refused call, with their texts
// together cut to the contract's notifyTextChars: the message that reaches it
// is cut and later ones are left out. Those attached whole count as read and
// announced: the read cursor, and the notified_id of a member (so its next
// notification does not repeat them), move to the last of them. The note
// tells where the rest is, or is "".
func (c *Core) attach(tx *sql.Tx, u unread) ([]unreadMessage, string, error) {
	budget := c.d.Contract.Hook.Limits.NotifyTextChars
	out := []unreadMessage{}
	var whole int64
	for _, m := range u.messages {
		if budget <= 0 {
			break
		}
		text, cut := protocol.CutBudget(m.Text, &budget)
		m.Text = text
		out = append(out, unreadMessage{m, cut})
		if cut {
			break
		}
		whole = m.row
	}
	note := ""
	if len(out) < len(u.messages) || out[len(out)-1].Cut {
		note = fmt.Sprintf(" Texts are cut at %d characters in all; read_messages(meetingId: %s) returns what is cut or left out.",
			c.d.Contract.Hook.Limits.NotifyTextChars, u.meetingID)
	}
	if whole == 0 {
		return out, note, nil
	}
	return out, note, c.markRead(tx, u.meetingID, u.reader, whole)
}

// setSendRefused records whether the reader's last send_message to the meeting was refused.
func (c *Core) setSendRefused(tx *sql.Tx, u unread, refused bool) error {
	_, err := tx.Exec(`
		INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at, send_refused) VALUES (?, 'meeting', ?, 0, ?, ?)
		ON CONFLICT (instance_id, context_type, context_id) DO UPDATE SET send_refused = excluded.send_refused`,
		u.reader, u.meetingID, c.now(), refused)
	return err
}

// unreadNote says how many unread messages are attached and which.
func unreadNote(u unread) string {
	return fmt.Sprintf("%d message(s) of others in meeting %s came after you last read it (%s); they are attached as unread.", len(u.messages), u.meetingID, u.span())
}

// readForCaller marks the host's message seq of a meeting, posted because of
// a call by who, read and announced for who: a caller need not read what its
// own call caused. Nothing moves when who had not read everything before it.
func (c *Core) readForCaller(tx *sql.Tx, meetingID, who string, seq int64) error {
	var row int64
	if err := tx.QueryRow(`SELECT id FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, seq).Scan(&row); err != nil {
		return err
	}
	unread, err := cursors.UnreadBefore(tx, meetingID, who, row)
	if err != nil || unread > 0 {
		return err
	}
	return c.markRead(tx, meetingID, who, row)
}

// markRead moves reader's read cursor of a meeting and its notified_id to row.
func (c *Core) markRead(tx *sql.Tx, meetingID, reader string, row int64) error {
	if err := cursors.Read(tx, reader, "meeting", meetingID, row, c.now()); err != nil {
		return err
	}
	return cursors.Announced(tx, meetingID, reader, row)
}
