package core

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// stanceReminder is what one meeting's reminder tells, after the commit.
type stanceReminder struct {
	meetingID, topic string
	seq              int64
	// to: the approvers reminded of their missing stance.
	to []string
	// author is the draft's author to tell who has not endorsed it yet, "" for none.
	author, waiting string
}

// RemindStances reminds the required approvers of a meeting's current draft
// that took no stance on it when the meeting has been quiet for after, and
// tells the draft's author once who has not endorsed it. Each approver and
// each author is told once per draft; the meeting itself does not change. It
// returns a log line or "".
func (c *Core) RemindStances(ctx context.Context, after time.Duration) (string, error) {
	now := c.d.Clock.Now()
	at, cutoff := store.ISO(now), store.ISO(now.Add(-after))
	var reminders []stanceReminder
	err := c.d.Store.Tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT m.id, m.topic, p.seq, p.sender, m.draft_reminded_at IS NULL
			FROM meetings m JOIN meeting_messages p ON p.id = m.current_proposal_id
			WHERE m.status = 'active'
			  AND (SELECT MAX(timestamp) FROM meeting_messages WHERE meeting_id = m.id) < ?
			ORDER BY m.active_order`, cutoff)
		if err != nil {
			return err
		}
		type draft struct {
			stanceReminder
			sender     string
			tellAuthor bool
		}
		var drafts []draft
		for rows.Next() {
			var d draft
			if err := rows.Scan(&d.meetingID, &d.topic, &d.seq, &d.sender, &d.tellAuthor); err != nil {
				rows.Close()
				return err
			}
			drafts = append(drafts, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, d := range drafts {
			// The approvers that have not endorsed the draft: no stance, or an objection.
			rows, err := tx.QueryContext(ctx, `
				SELECT a.member_id, COALESCE(s.name, ''), st.stance, a.reminded_at IS NULL
				FROM meeting_approvers a
				JOIN meetings m ON m.id = a.meeting_id
				LEFT JOIN meeting_stances st ON st.meeting_id = a.meeting_id AND st.message_id = m.current_proposal_id AND st.member_id = a.member_id AND st.withdrawn = 0
				LEFT JOIN agent_sessions s ON s.id = a.member_id
				WHERE a.meeting_id = ? AND (st.stance IS NULL OR st.stance != 'endorse') AND a.member_id IS NOT m.seat_member_id
				ORDER BY a.rowid`, d.meetingID)
			if err != nil {
				return err
			}
			var waiting []string
			for rows.Next() {
				var id, name string
				var stance sql.NullString
				var unreminded bool
				if err := rows.Scan(&id, &name, &stance, &unreminded); err != nil {
					rows.Close()
					return err
				}
				label := id
				if name != "" {
					label = fmt.Sprintf("%s (%s)", name, id)
				}
				if stance.Valid {
					label += " (objected)"
				} else if unreminded {
					d.to = append(d.to, id)
				}
				waiting = append(waiting, label)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			if len(waiting) == 0 {
				continue
			}
			for _, id := range d.to {
				if _, err := tx.ExecContext(ctx, `UPDATE meeting_approvers SET reminded_at = ? WHERE meeting_id = ? AND member_id = ?`, at, d.meetingID, id); err != nil {
					return err
				}
			}
			if d.tellAuthor {
				if _, err := tx.ExecContext(ctx, `UPDATE meetings SET draft_reminded_at = ? WHERE id = ?`, at, d.meetingID); err != nil {
					return err
				}
				if c.isSession(d.sender) {
					d.author, d.waiting = d.sender, strings.Join(waiting, ", ")
				}
			}
			if len(d.to) > 0 || d.author != "" {
				reminders = append(reminders, d.stanceReminder)
			}
		}
		return nil
	})
	if err != nil || len(reminders) == 0 {
		return "", err
	}
	texts := c.d.Contract.Hook.Texts
	approvers, authors := 0, 0
	for _, r := range reminders {
		approvers += len(r.to)
		if r.author != "" {
			authors++
		}
		if c.d.Meetings == nil {
			continue
		}
		if len(r.to) > 0 {
			c.d.Meetings.MeetingNotice(r.meetingID, r.to, fmt.Sprintf(texts.StanceReminder, r.topic, r.meetingID, r.seq, r.seq))
		}
		if r.author != "" {
			c.d.Meetings.MeetingNotice(r.meetingID, []string{r.author}, fmt.Sprintf(texts.StanceWaiting, r.topic, r.meetingID, r.seq, r.waiting))
		}
	}
	return fmt.Sprintf("stance reminders: %d approvers and %d draft authors in %d meetings", approvers, authors, len(reminders)), nil
}

// isSession: whether a sender is a conversation session (<client>:<id>), not an adapter instance.
func (c *Core) isSession(id string) bool {
	for _, client := range c.d.Contract.Hook.Clients {
		if strings.HasPrefix(id, client+":") {
			return true
		}
	}
	return false
}
