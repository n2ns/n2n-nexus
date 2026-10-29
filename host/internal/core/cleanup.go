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
			return store.ErrDryRun
		}
		if r.Counts.total() == 0 {
			return nil
		}
		return c.recordEvent(tx, actor, "maintenance.cleanup", "", map[string]any{"counts": r.Counts, "meetings": r.Meetings, "sessions": r.Sessions})
	})
	if err != nil && !errors.Is(err, store.ErrDryRun) {
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
	return store.Append(nil, rows, err, func(rows *sql.Rows) (cleanedMeeting, error) {
		var m cleanedMeeting
		return m, rows.Scan(&m.ID, &m.Topic)
	})
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
