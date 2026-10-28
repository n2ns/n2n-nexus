package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// errDryRun rolls back the transaction of a dry-run cleanup.
var errDryRun = errors.New("dry run")

// cleanupCounts are the rows a cleanup removed or changed, or would.
type cleanupCounts struct {
	TasksExpired    int64 `json:"tasksExpired"`
	Tasks           int64 `json:"tasks"`
	Events          int64 `json:"events"`
	MeetingsExpired int64 `json:"meetingsExpired"`
	Meetings        int64 `json:"meetings"`
	MessagesExpired int64 `json:"messagesExpired"`
	Messages        int64 `json:"messages"`
	Notices         int64 `json:"notices"`
	ToolUseBindings int64 `json:"toolUseBindings"`
	Sessions        int64 `json:"sessions"`
	Instances       int64 `json:"instances"`
}

func (n cleanupCounts) total() int64 {
	return n.TasksExpired + n.Tasks + n.Events + n.MeetingsExpired + n.Meetings +
		n.MessagesExpired + n.Messages + n.Notices + n.ToolUseBindings + n.Sessions + n.Instances
}

// cleanedMeeting is a meeting a cleanup closed (expire) or deleted (delete).
type cleanedMeeting struct {
	ID     string `json:"id"`
	Topic  string `json:"topic"`
	Action string `json:"action"`
}

// cleanupReport is what a cleanup did, or with DryRun would do.
type cleanupReport struct {
	DryRun   bool                 `json:"dryRun"`
	Counts   cleanupCounts        `json:"counts"`
	Meetings []cleanedMeeting     `json:"meetings"`
	Sessions []api.CleanedSession `json:"sessions"`
}

// Cleanup removes what is past retention. Core rows: tasks past their TTL
// fail; finished tasks and events go RetentionDays after; an active meeting
// without a message for MeetingRetentionDays (since its last message, start
// or reopening) closes with endReason expired; a closed or archived meeting
// goes MeetingRetentionDays after it closed (or started, when it has no end
// time), with its read cursors. The Cleaner then cleans the conversations.
// A cleanup that changed something records a maintenance.cleanup event as
// actor. With dryRun nothing changes and the report says what would.
func (c *Core) Cleanup(ctx context.Context, actor string, dryRun bool) (cleanupReport, error) {
	r := cleanupReport{DryRun: dryRun, Meetings: []cleanedMeeting{}, Sessions: []api.CleanedSession{}}
	if c.d.Cleaner != nil {
		ag, err := c.d.Cleaner.Cleanup(ctx, dryRun)
		if err != nil {
			return r, err
		}
		r.Counts.MessagesExpired, r.Counts.Messages, r.Counts.Notices = ag.MessagesExpired, ag.Messages, ag.Notices
		r.Counts.ToolUseBindings, r.Counts.Instances = ag.ToolUseBindings, ag.Instances
		r.Counts.Sessions = int64(len(ag.Sessions))
		r.Sessions = append(r.Sessions, ag.Sessions...)
	}
	now := c.d.Clock.Now()
	cutoff := store.ISO(now.AddDate(0, 0, -c.d.RetentionDays))
	meetingCutoff := store.ISO(now.AddDate(0, 0, -c.d.MeetingRetentionDays))
	err := c.d.Store.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		if r.Counts.TasksExpired, err = expireTasks(tx, now); err != nil {
			return err
		}
		if r.Counts.Tasks, err = exec(tx, `DELETE FROM tasks WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?`, cutoff); err != nil {
			return err
		}
		if r.Counts.Events, err = exec(tx, `DELETE FROM events WHERE timestamp < ?`, cutoff); err != nil {
			return err
		}
		stale, err := meetingsWhere(tx, `m.status = 'active' AND MAX(m.created_at, COALESCE(m.reopened_at, ''),
			COALESCE((SELECT MAX(timestamp) FROM meeting_messages WHERE meeting_id = m.id), '')) < ?`, meetingCutoff)
		if err != nil {
			return err
		}
		summary := fmt.Sprintf("closed by the host after %d days without a message", c.d.MeetingRetentionDays)
		for _, m := range stale {
			if err := c.closeMeeting(tx, m.ID, summary, "expired"); err != nil {
				return err
			}
			r.Meetings = append(r.Meetings, cleanedMeeting{m.ID, m.Topic, "expire"})
		}
		r.Counts.MeetingsExpired = int64(len(stale))
		old, err := meetingsWhere(tx, `m.status IN ('closed', 'archived') AND COALESCE(m.closed_at, m.created_at) < ?`, meetingCutoff)
		if err != nil {
			return err
		}
		for _, m := range old {
			if _, err := tx.Exec(`DELETE FROM read_cursors WHERE context_type = 'meeting' AND context_id = ?`, m.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(`DELETE FROM meetings WHERE id = ?`, m.ID); err != nil {
				return err
			}
			r.Meetings = append(r.Meetings, cleanedMeeting{m.ID, m.Topic, "delete"})
		}
		r.Counts.Meetings = int64(len(old))
		if dryRun {
			return errDryRun
		}
		if r.Counts.total() == 0 {
			return nil
		}
		return c.recordEvent(tx, actor, "maintenance.cleanup", "", map[string]any{"counts": r.Counts, "meetings": r.Meetings, "sessions": r.Sessions})
	})
	if err != nil && !errors.Is(err, errDryRun) {
		return r, err
	}
	if !dryRun {
		for _, m := range expiredIDs(r.Meetings) {
			c.afterMeetingChange(m, "", false, true)
		}
	}
	return r, nil
}

// expiredIDs lists the ids of the meetings a cleanup closed.
func expiredIDs(meetings []cleanedMeeting) []string {
	var ids []string
	for _, m := range meetings {
		if m.Action == "expire" {
			ids = append(ids, m.ID)
		}
	}
	return ids
}

// meetingsWhere lists the meetings (aliased m) matching cond, oldest first.
func meetingsWhere(tx *sql.Tx, cond string, args ...any) ([]cleanedMeeting, error) {
	rows, err := tx.Query(`SELECT m.id, m.topic FROM meetings m WHERE `+cond+` ORDER BY m.created_at, m.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []cleanedMeeting
	for rows.Next() {
		var m cleanedMeeting
		if err := rows.Scan(&m.ID, &m.Topic); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Maintain runs the hourly cleanup; it returns a log line or "".
func (c *Core) Maintain(ctx context.Context) (string, error) {
	r, err := c.Cleanup(ctx, "host", false)
	if err != nil || r.Counts.total() == 0 {
		return "", err
	}
	return "cleanup: " + r.Counts.String(), nil
}

// String lists the non-zero counts, as "3 events, 1 meetingsExpired".
func (n cleanupCounts) String() string {
	var parts []string
	for _, p := range []struct {
		name string
		n    int64
	}{
		{"tasksExpired", n.TasksExpired}, {"tasks", n.Tasks}, {"events", n.Events},
		{"meetingsExpired", n.MeetingsExpired}, {"meetings", n.Meetings},
		{"messagesExpired", n.MessagesExpired}, {"messages", n.Messages}, {"notices", n.Notices},
		{"toolUseBindings", n.ToolUseBindings}, {"sessions", n.Sessions}, {"instances", n.Instances},
	} {
		if p.n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", p.n, p.name))
		}
	}
	if len(parts) == 0 {
		return "nothing"
	}
	return strings.Join(parts, ", ")
}

// exportMeeting writes a meeting as markdown: its state, members (left ones
// included), decisions and messages, each with who wrote it and where.
func exportMeeting(tx *sql.Tx, id string) (string, error) {
	var topic, status, created string
	var closed, summary, reason sql.NullString
	err := tx.QueryRow(`SELECT topic, status, created_at, closed_at, summary, end_reason FROM meetings WHERE id = ?`, id).
		Scan(&topic, &status, &created, &closed, &summary, &reason)
	if err == sql.ErrNoRows {
		return "", notFoundMeeting(id)
	}
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n- Meeting: %s\n- Status: %s", topic, id, status)
	if reason.Valid {
		fmt.Fprintf(&b, " (%s)", reason.String)
	}
	fmt.Fprintf(&b, "\n- Started: %s\n", created)
	if closed.Valid {
		fmt.Fprintf(&b, "- Ended: %s\n", closed.String)
	}
	if summary.Valid && summary.String != "" {
		fmt.Fprintf(&b, "- Summary: %s\n", summary.String)
	}
	backfilled := false

	b.WriteString("\n## Members\n\n")
	rows, err := tx.Query(`SELECT member_id, name, title, machine, snapshot_backfilled, joined_at, left_at
		FROM meeting_members WHERE meeting_id = ? ORDER BY joined_at, rowid`, id)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var member, joined string
		var name, title, machine, left sql.NullString
		var filled bool
		if err := rows.Scan(&member, &name, &title, &machine, &filled, &joined, &left); err != nil {
			rows.Close()
			return "", err
		}
		fmt.Fprintf(&b, "- %s", who(member, name, machine, filled))
		if title.String != "" {
			fmt.Fprintf(&b, " \"%s\"", title.String)
		}
		fmt.Fprintf(&b, ", joined %s", joined)
		if left.Valid {
			fmt.Fprintf(&b, ", left %s", left.String)
		}
		b.WriteString("\n")
		backfilled = backfilled || filled
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	rows, err = tx.Query(`SELECT content, timestamp FROM decisions WHERE meeting_id = ? ORDER BY id`, id)
	if err != nil {
		return "", err
	}
	first := true
	for rows.Next() {
		var content, at string
		if err := rows.Scan(&content, &at); err != nil {
			rows.Close()
			return "", err
		}
		if first {
			b.WriteString("\n## Decisions\n")
			first = false
		}
		fmt.Fprintf(&b, "\n### %s\n\n%s\n", at, content)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	messages, err := sourceOf(id).query(tx, "1", "ORDER BY m.id")
	if err != nil {
		return "", err
	}
	b.WriteString("\n## Messages\n")
	for _, m := range messages {
		fmt.Fprintf(&b, "\n### #%d %s · %s", m.ID, who(m.From, toNull(m.SenderName), toNull(m.SenderMachine), m.SenderBackfilled), m.Timestamp)
		if m.Category != nil {
			fmt.Fprintf(&b, " · %s", *m.Category)
		}
		fmt.Fprintf(&b, "\n\n%s\n", m.Text)
		backfilled = backfilled || m.SenderBackfilled
	}
	if backfilled {
		b.WriteString("\n---\n\n\\* Name and machine recorded when the database was upgraded, from the session as it was then, not when the member joined or the message was written.\n")
	}
	return b.String(), nil
}

// who is how the export shows a sender or member: "name (machine)", the id
// when no name was recorded, with * when the name was backfilled.
func who(id string, name, machine sql.NullString, backfilled bool) string {
	s := id
	if name.Valid {
		s = name.String
	}
	if machine.Valid {
		s += " (" + machine.String + ")"
	}
	if backfilled {
		s += "\\*"
	}
	return s
}

func toNull(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}
