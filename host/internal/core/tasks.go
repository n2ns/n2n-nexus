package core

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

func notFoundTask(id string) error { return api.Errorf("Task '%s' not found.", id) }

// task is a task as get_task returns it.
type task struct {
	ID              string          `json:"id"`
	Status          string          `json:"status"`
	Progress        float64         `json:"progress"`
	SourceMeetingID *string         `json:"source_meeting_id"`
	Metadata        json.RawMessage `json:"metadata"`
	ResultURI       *string         `json:"result_uri"`
	ErrorMessage    *string         `json:"error_message"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
	TTL             *int64          `json:"ttl"`
}

const taskColumns = `id, status, progress, source_meeting_id, metadata, result_uri, error_message, created_at, updated_at, ttl`

type scanner interface{ Scan(dest ...any) error }

func scanTask(s scanner) (task, error) {
	var t task
	var meeting, metadata, uri, message sql.NullString
	var ttl sql.NullInt64
	if err := s.Scan(&t.ID, &t.Status, &t.Progress, &meeting, &metadata, &uri, &message, &t.CreatedAt, &t.UpdatedAt, &ttl); err != nil {
		return t, err
	}
	// Empty strings read as null, as they always have.
	str := func(v sql.NullString) *string {
		if !v.Valid || v.String == "" {
			return nil
		}
		return &v.String
	}
	t.SourceMeetingID, t.ResultURI, t.ErrorMessage = str(meeting), str(uri), str(message)
	t.Metadata = json.RawMessage("{}")
	if metadata.Valid && metadata.String != "" {
		t.Metadata = json.RawMessage(metadata.String)
	}
	if ttl.Valid && ttl.Int64 != 0 {
		t.TTL = &ttl.Int64
	}
	return t, nil
}

func loadTask(tx *sql.Tx, id string) (task, error) {
	t, err := scanTask(tx.QueryRow(`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return t, notFoundTask(id)
	}
	return t, err
}

// expireTasks marks pending / running tasks past their TTL as failed.
func expireTasks(tx *sql.Tx, now time.Time) (int64, error) {
	return exec(tx, `
		UPDATE tasks SET status = 'failed', error_message = 'TTL expired', updated_at = ?
		WHERE status IN ('pending', 'running') AND ttl IS NOT NULL
			AND ROUND(unixepoch(created_at, 'subsec') * 1000) + ttl < ?`,
		store.ISO(now), now.UnixMilli())
}

// ---------------------------------------------------------------------------
// create_task

type createTaskArgs struct {
	SourceMeetingID string          `json:"source_meeting_id"`
	Metadata        json.RawMessage `json:"metadata"`
	TTL             int64           `json:"ttl"`
}

func (c *Core) createTask(call api.Call, a createTaskArgs) (any, error) {
	now := c.d.Clock.Now()
	id := "task_" + compactTime(now) + "_" + randomSuffix()
	var t task
	err := c.tx(call, func(tx *sql.Tx) error {
		if a.SourceMeetingID != "" {
			if ok, err := meetingExists(tx, a.SourceMeetingID); err != nil {
				return err
			} else if !ok {
				return notFoundMeeting(a.SourceMeetingID)
			}
		}
		var metadata, ttl any
		if len(a.Metadata) > 0 {
			metadata = string(a.Metadata)
		}
		if a.TTL > 0 {
			ttl = a.TTL
		}
		if _, err := tx.Exec(`
			INSERT INTO tasks (id, status, progress, source_meeting_id, metadata, created_at, updated_at, ttl)
			VALUES (?, 'pending', 0.0, ?, ?, ?, ?, ?)`,
			id, nullString(a.SourceMeetingID), metadata, store.ISO(now), store.ISO(now), ttl); err != nil {
			return err
		}
		var err error
		t, err = loadTask(tx, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"task_id": t.ID, "status": t.Status, "message": "Task created.", "task": t}, nil
}

// ---------------------------------------------------------------------------
// get_task, list_tasks

type taskIDArgs struct {
	TaskID string `json:"taskId"`
}

func (c *Core) getTask(call api.Call, a taskIDArgs) (any, error) {
	var t task
	err := c.tx(call, func(tx *sql.Tx) error {
		var err error
		t, err = loadTask(tx, a.TaskID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

type listTasksArgs struct {
	Status string `json:"status"`
	Limit  int    `json:"limit"`
}

func (c *Core) listTasks(call api.Call, a listTasksArgs) (any, error) {
	tasks := []task{}
	err := c.tx(call, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT `+taskColumns+` FROM tasks WHERE ? = '' OR status = ?
			ORDER BY created_at DESC, rowid DESC LIMIT ?`, a.Status, a.Status, a.Limit)
		tasks, err = store.Append(tasks, rows, err, func(rows *sql.Rows) (task, error) { return scanTask(rows) })
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": len(tasks), "tasks": tasks}, nil
}

// ---------------------------------------------------------------------------
// update_task, cancel_task

type updateTaskArgs struct {
	TaskID       string          `json:"taskId"`
	Status       *string         `json:"status"`
	Progress     *float64        `json:"progress"`
	ResultURI    *string         `json:"result_uri"`
	ErrorMessage *string         `json:"error_message"`
	Metadata     json.RawMessage `json:"metadata"`
}

func (c *Core) updateTask(call api.Call, a updateTaskArgs) (any, error) {
	sets := []string{"updated_at = ?"}
	values := []any{c.now()}
	set := func(column string, v any) {
		sets = append(sets, column+" = ?")
		values = append(values, v)
	}
	if a.Status != nil {
		set("status", *a.Status)
	}
	if a.Progress != nil {
		set("progress", *a.Progress)
	}
	if a.ResultURI != nil {
		set("result_uri", *a.ResultURI)
	}
	if a.ErrorMessage != nil {
		set("error_message", *a.ErrorMessage)
	}
	if len(a.Metadata) > 0 {
		set("metadata", string(a.Metadata))
	}
	values = append(values, a.TaskID)
	var t task
	err := c.tx(call, func(tx *sql.Tx) error {
		n, err := exec(tx, `UPDATE tasks SET `+strings.Join(sets, ", ")+` WHERE id = ?`, values...)
		if err != nil {
			return err
		}
		if n == 0 {
			return notFoundTask(a.TaskID)
		}
		t, err = loadTask(tx, a.TaskID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (c *Core) cancelTask(call api.Call, a taskIDArgs) (any, error) {
	err := c.tx(call, func(tx *sql.Tx) error {
		n, err := exec(tx, `UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')`,
			c.now(), a.TaskID)
		if err != nil {
			return err
		}
		if n == 0 {
			var status string
			if err := tx.QueryRow(`SELECT status FROM tasks WHERE id = ?`, a.TaskID).Scan(&status); err == sql.ErrNoRows {
				return notFoundTask(a.TaskID)
			} else if err != nil {
				return err
			}
			return api.Errorf("Task '%s' is already %s and cannot be cancelled.", a.TaskID, status)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "taskId": a.TaskID, "message": "Task cancelled."}, nil
}
