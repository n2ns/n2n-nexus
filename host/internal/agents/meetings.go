package agents

import (
	"database/sql"
	"fmt"
	"slices"

	"github.com/n2ns/n2n-nexus/host/internal/cursors"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Meetings reach their members through the same notifications as direct
// messages. A member's notified_id (meeting_members) is the newest meeting
// message it was told about: the messages of others above it are its news,
// each shown with its text. Active members are woken by news; async members
// see it at their next hook. Instance members (clients without hooks) are
// never told. As with direct messages, what a notification that drives the
// turn or reaches the conversation shows whole is read: the member's read
// cursor (read_cursors) moves to the last message shown whole, when every
// message of others before it was read or shown whole too.

// meetingNews is what a member has not been told about one meeting.
type meetingNews struct {
	meetingID, topic string
	active           bool
	// messages: the news, oldest first.
	messages []newsMessage
}

// newsMessage is a meeting message of news; row is its table id, seq its number in the meeting.
type newsMessage struct {
	row, seq                          int64
	name, machine, category, text, at string
}

// upTo is the table id of the newest message of the news.
func (n meetingNews) upTo() int64 { return n.messages[len(n.messages)-1].row }

// news lists the meetings with news for a session: active meetings it takes part in, oldest membership first.
func (a *Agents) news(sessionID string) ([]meetingNews, error) {
	rows, err := a.db().QueryContext(bg, `
		SELECT mm.meeting_id, m.topic, mm.mode, mm.notified_id FROM meeting_members mm JOIN meetings m ON m.id = mm.meeting_id
		WHERE mm.member_id = ? AND mm.left_at IS NULL AND m.status = 'active' ORDER BY mm.joined_at, mm.rowid`, sessionID)
	type membership struct {
		id, topic, mode string
		notified        int64
	}
	list, err := store.Append(nil, rows, err, func(rows *sql.Rows) (membership, error) {
		var m membership
		return m, rows.Scan(&m.id, &m.topic, &m.mode, &m.notified)
	})
	if err != nil {
		return nil, err
	}
	var out []meetingNews
	for _, m := range list {
		n := meetingNews{meetingID: m.id, topic: m.topic, active: m.mode == "active"}
		rows, err := a.db().QueryContext(bg, `SELECT id, seq, COALESCE(sender_name, sender), COALESCE(sender_machine, ''), COALESCE(category, ''), text, timestamp
			FROM meeting_messages WHERE meeting_id = ? AND id > ? AND sender != ? ORDER BY id`, m.id, m.notified, sessionID)
		if n.messages, err = store.Append(n.messages, rows, err, func(rows *sql.Rows) (newsMessage, error) {
			var msg newsMessage
			return msg, rows.Scan(&msg.row, &msg.seq, &msg.name, &msg.machine, &msg.category, &msg.text, &msg.at)
		}); err != nil {
			return nil, err
		}
		if len(n.messages) > 0 {
			out = append(out, n)
		}
	}
	return out, nil
}

// newsLines shows the news of the meetings, every text whole until the texts
// together reach the contract's notifyTextChars; the message that reaches it
// is cut and the later ones are only counted. It returns the lines, whether
// something was cut or left out, and per meeting the table id of the last
// message shown whole with every one before it shown whole too (0: none).
func (a *Agents) newsLines(news []meetingNews) ([]string, bool, map[string]int64) {
	h := a.o.Contract.Hook
	budget := h.Limits.NotifyTextChars
	var lines []string
	rest := false
	whole := map[string]int64{}
	for _, n := range news {
		first, last := n.messages[0].seq, n.messages[len(n.messages)-1].seq
		lines = append(lines, h.Texts.NoticePrefix+" "+fmt.Sprintf(h.Texts.MeetingNews, n.topic, n.meetingID, len(n.messages), first, last))
		cut := false
		for i, m := range n.messages {
			if cut || budget <= 0 {
				rest = true
				lines = append(lines, fmt.Sprintf(h.Texts.MeetingNotShown, len(n.messages)-i, m.seq, last))
				break
			}
			category := ""
			if m.category != "" {
				category = " (" + m.category + ")"
			}
			lines = append(lines, fmt.Sprintf(h.Texts.MeetingMessageHeader, m.seq, displayName(m.name, m.machine, ""), m.at, category))
			text, textCut := protocol.CutBudget(m.text, &budget)
			lines = append(lines, text)
			if textCut {
				cut, rest = true, true
				lines = append(lines, fmt.Sprintf(h.Texts.MessageCut, protocol.UnitLen(text), protocol.UnitLen(m.text)))
			} else {
				whole[n.meetingID] = m.row
			}
			lines = append(lines, fmt.Sprintf(h.Texts.MeetingMessageEnd, m.seq))
		}
	}
	return lines, rest, whole
}

// memberState is a member's notification and read state, kept to undo a wake whose delivery failed.
type memberState struct {
	meetingID string
	notified  int64
	wakes     int64
	wokenAt   sql.NullString
	// cursor is the member's read cursor, NULL when it had none.
	cursor sql.NullInt64
}

// countMeetingWakes counts active meeting wakes and saves every announced
// meeting's state, including async news carried with another wake (mu held).
func (a *Agents) countMeetingWakes(sessionID string, news []meetingNews) ([]memberState, error) {
	var before []memberState
	now := a.iso(a.o.Clock.Now())
	for _, n := range news {
		s := memberState{meetingID: n.meetingID}
		if err := a.db().QueryRowContext(bg, `SELECT mm.notified_id, mm.wakes, mm.last_woken_at, rc.last_read_id
			FROM meeting_members mm LEFT JOIN read_cursors rc ON rc.instance_id = mm.member_id AND rc.context_type = 'meeting' AND rc.context_id = mm.meeting_id
			WHERE mm.meeting_id = ? AND mm.member_id = ?`,
			n.meetingID, sessionID).Scan(&s.notified, &s.wakes, &s.wokenAt, &s.cursor); err != nil {
			return nil, err
		}
		if n.active {
			if _, err := a.db().ExecContext(bg, "UPDATE meeting_members SET wakes = wakes + 1, last_woken_at = ? WHERE meeting_id = ? AND member_id = ?",
				now, n.meetingID, sessionID); err != nil {
				return nil, err
			}
		}
		before = append(before, s)
	}
	return before, nil
}

// markMeetingsNotified moves the session's watermarks past the news and, for
// the meetings in read, its read cursor to the given message when no message
// of others between the cursor and the news is left unread.
func (a *Agents) markMeetingsNotified(tx *sql.Tx, sessionID string, news []meetingNews, read map[string]int64) error {
	now := a.iso(a.o.Clock.Now())
	for _, n := range news {
		if err := cursors.Announced(tx, n.meetingID, sessionID, n.upTo()); err != nil {
			return err
		}
		to, ok := read[n.meetingID]
		if !ok || to == 0 {
			continue
		}
		gap, err := cursors.UnreadBefore(tx, n.meetingID, sessionID, n.messages[0].row)
		if err != nil {
			return err
		}
		if gap > 0 {
			continue
		}
		if err := cursors.Read(tx, sessionID, "meeting", n.meetingID, to, now); err != nil {
			return err
		}
	}
	return nil
}

// restoreMembers puts members' notification and read states back (a wake whose delivery failed).
func (a *Agents) restoreMembers(sessionID string, states []memberState) error {
	return a.tx(func(tx *sql.Tx) error {
		for _, s := range states {
			if _, err := tx.ExecContext(bg, "UPDATE meeting_members SET notified_id = ?, wakes = ?, last_woken_at = ? WHERE meeting_id = ? AND member_id = ?",
				s.notified, s.wakes, s.wokenAt, s.meetingID, sessionID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(bg, "UPDATE read_cursors SET last_read_id = ? WHERE instance_id = ? AND context_type = 'meeting' AND context_id = ?",
				s.cursor.Int64, sessionID, s.meetingID); err != nil {
				return err
			}
		}
		return nil
	})
}

// members: the sessions taking part in a meeting that have not left; with activeOnly, only active ones.
func (a *Agents) members(meetingID string, activeOnly bool) ([]string, error) {
	query := `SELECT mm.member_id FROM meeting_members mm JOIN agent_sessions s ON s.id = mm.member_id
		WHERE mm.meeting_id = ? AND mm.left_at IS NULL`
	if activeOnly {
		query += " AND mm.mode = 'active'"
	}
	rows, err := a.db().QueryContext(bg, query+" ORDER BY mm.joined_at, mm.rowid", meetingID)
	return store.Append(nil, rows, err, store.ScanString)
}

// MeetingUpdated (api.MeetingNotifier): the meeting has new messages; the waits
// of its active members check for news.
func (a *Agents) MeetingUpdated(meetingID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids, err := a.members(meetingID, true)
	a.logErr("meeting updated", err)
	a.wake(ids...)
}

// MeetingClosed (api.MeetingNotifier): every member but byID, who ended it,
// gets one notice that the meeting ended, which needs no reply; active members
// are woken with it, async ones see it at their next hook.
func (a *Agents) MeetingClosed(meetingID, byID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var topic string
	var summary sql.NullString
	if err := a.db().QueryRowContext(bg, "SELECT topic, summary FROM meetings WHERE id = ?", meetingID).Scan(&topic, &summary); err != nil {
		a.logErr("meeting closed", err)
		return
	}
	ids, err := a.members(meetingID, false)
	if err != nil {
		a.logErr("meeting closed", err)
		return
	}
	detail := ""
	if summary.String != "" {
		detail = ": " + summary.String
	}
	text := fmt.Sprintf(a.o.Contract.Hook.Texts.MeetingEnded, topic, meetingID, detail)
	now := a.o.Clock.Now()
	err = a.tx(func(tx *sql.Tx) error {
		for _, id := range ids {
			if id == byID {
				continue
			}
			if err := a.addNotice(tx, id, text, meetingID, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		a.logErr("meeting closed", err)
		return
	}
	active, err := a.members(meetingID, true)
	a.logErr("meeting closed", err)
	a.wake(slices.DeleteFunc(active, func(id string) bool { return id == byID })...)
}

// MeetingNotice (api.MeetingNotifier): each of the sessions in to that exists
// gets the notice from the meeting; those that are active members of it (and
// have not left) are woken with it, others see it at their next hook.
func (a *Agents) MeetingNotice(meetingID string, to []string, text string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.o.Clock.Now()
	told := map[string]bool{}
	err := a.tx(func(tx *sql.Tx) error {
		for _, id := range to {
			if told[id] {
				continue
			}
			s, err := getSession(tx, id)
			if err != nil {
				return err
			}
			if s == nil {
				continue
			}
			if err := a.addNotice(tx, id, text, meetingID, now); err != nil {
				return err
			}
			told[id] = true
		}
		return nil
	})
	if err != nil {
		a.logErr("meeting notice", err)
		return
	}
	active, err := a.members(meetingID, true)
	a.logErr("meeting notice", err)
	a.wake(slices.DeleteFunc(active, func(id string) bool { return !told[id] })...)
}
