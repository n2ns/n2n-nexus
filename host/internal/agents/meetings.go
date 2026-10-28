package agents

import (
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// Meetings reach their members through the same notifications as direct
// messages. A member's notified_id (meeting_members) is the newest meeting
// message it was told about: the messages of others above it are its news, one
// line per meeting. Active members are woken by news; async members see it at
// their next hook. Instance members (clients without hooks) are never told.

// meetingNews is what a member has not been told about one meeting.
type meetingNews struct {
	meetingID, topic string
	active           bool
	count            int
	// first and last are message numbers in the meeting; upTo the table id of the newest.
	first, last, upTo int64
	senders           []string
}

// news lists the meetings with news for a session: active meetings it takes part in, oldest membership first.
func (a *Agents) news(sessionID string) ([]meetingNews, error) {
	rows, err := a.db().QueryContext(bg, `
		SELECT mm.meeting_id, m.topic, mm.mode, mm.notified_id FROM meeting_members mm JOIN meetings m ON m.id = mm.meeting_id
		WHERE mm.member_id = ? AND mm.left_at IS NULL AND m.status = 'active' ORDER BY mm.joined_at, mm.rowid`, sessionID)
	if err != nil {
		return nil, err
	}
	type membership struct {
		id, topic, mode string
		notified        int64
	}
	var list []membership
	for rows.Next() {
		var m membership
		if err := rows.Scan(&m.id, &m.topic, &m.mode, &m.notified); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []meetingNews
	for _, m := range list {
		n := meetingNews{meetingID: m.id, topic: m.topic, active: m.mode == "active"}
		var first, last, upTo sql.NullInt64
		if err := a.db().QueryRowContext(bg, `SELECT COUNT(*), MIN(seq), MAX(seq), MAX(id) FROM meeting_messages
			WHERE meeting_id = ? AND id > ? AND sender != ?`, m.id, m.notified, sessionID).Scan(&n.count, &first, &last, &upTo); err != nil {
			return nil, err
		}
		if n.count == 0 {
			continue
		}
		n.first, n.last, n.upTo = first.Int64, last.Int64, upTo.Int64
		senders, err := a.db().QueryContext(bg, `SELECT COALESCE(MAX(mm.sender_name), mm.sender) FROM meeting_messages mm
			WHERE mm.meeting_id = ? AND mm.id > ? AND mm.sender != ? GROUP BY mm.sender ORDER BY MIN(mm.id)`, m.id, m.notified, sessionID)
		if err != nil {
			return nil, err
		}
		for senders.Next() {
			var name string
			if err := senders.Scan(&name); err != nil {
				senders.Close()
				return nil, err
			}
			n.senders = append(n.senders, name)
		}
		senders.Close()
		if err := senders.Err(); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

// newsLine is the one-line notification of a meeting's news.
func (a *Agents) newsLine(n meetingNews) string {
	h := a.o.Contract.Hook
	return h.Texts.NoticePrefix + " " + fmt.Sprintf(h.Texts.MeetingNews, n.topic, n.meetingID, n.count, n.first, n.last, strings.Join(n.senders, ", "))
}

// memberState is a member's notification state, kept to undo a wake whose delivery failed.
type memberState struct {
	meetingID string
	notified  int64
	wakes     int64
	wokenAt   sql.NullString
}

// countMeetingWakes counts active meeting wakes and saves every announced
// meeting's state, including async news carried with another wake (mu held).
func (a *Agents) countMeetingWakes(sessionID string, news []meetingNews) ([]memberState, error) {
	var before []memberState
	now := a.iso(a.o.Clock.Now())
	for _, n := range news {
		s := memberState{meetingID: n.meetingID}
		if err := a.db().QueryRowContext(bg, "SELECT notified_id, wakes, last_woken_at FROM meeting_members WHERE meeting_id = ? AND member_id = ?",
			n.meetingID, sessionID).Scan(&s.notified, &s.wakes, &s.wokenAt); err != nil {
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

// markMeetingsNotified moves the session's watermarks past the news.
func (a *Agents) markMeetingsNotified(tx *sql.Tx, sessionID string, news []meetingNews) error {
	for _, n := range news {
		if _, err := tx.ExecContext(bg, "UPDATE meeting_members SET notified_id = ? WHERE meeting_id = ? AND member_id = ? AND notified_id < ?",
			n.upTo, n.meetingID, sessionID, n.upTo); err != nil {
			return err
		}
	}
	return nil
}

// restoreMembers puts members' notification states back (a wake whose delivery failed).
func (a *Agents) restoreMembers(sessionID string, states []memberState) error {
	return a.tx(func(tx *sql.Tx) error {
		for _, s := range states {
			if _, err := tx.ExecContext(bg, "UPDATE meeting_members SET notified_id = ?, wakes = ?, last_woken_at = ? WHERE meeting_id = ? AND member_id = ?",
				s.notified, s.wakes, s.wokenAt, s.meetingID, sessionID); err != nil {
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
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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
