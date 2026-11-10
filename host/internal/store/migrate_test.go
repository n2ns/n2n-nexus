package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// 0004 rebuilds meetings without losing a row of it or of the tables that
// refer to it, and fills the snapshots from the sessions as they are.
func TestMigrationRetentionKeepsMeetingsAndBackfills(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, FileName))+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_core.sql", "0002_agents.sql", "0003_session_environment.sql"} {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, q := range []string{
		`PRAGMA user_version = 3`,
		`INSERT INTO agent_sessions (id, client, name, cwd, status, created_at, last_active_at, title, hostname, platform, utc_offset, label, environment)
			VALUES ('claude:1', 'claude', 'claude@p#1', '/p', 'idle', 't', 't', 'Work', 'box', 'wsl', 0, '', 'Ubuntu')`,
		`INSERT INTO meetings (id, topic, status, active_order, initiator, participants, created_at, closed_at, end_reason)
			VALUES ('m1', 'Topic', 'closed', 1, 'claude:1', '[]', 't', 't', 'consensus')`,
		`INSERT INTO meeting_messages (meeting_id, seq, sender, text, timestamp) VALUES ('m1', 1, 'claude:1', 'hi', 't'), ('m1', 2, 'mcp-x', 'yo', 't')`,
		`INSERT INTO meeting_members (meeting_id, member_id, identity_kind, mode, approver, joined_at) VALUES ('m1', 'claude:1', 'session', 'active', 'required', 't')`,
		`INSERT INTO meeting_approvers (meeting_id, member_id) VALUES ('m1', 'claude:1')`,
		`INSERT INTO meeting_stances (meeting_id, message_id, member_id, identity_kind, stance, at) VALUES ('m1', 1, 'claude:1', 'session', 'endorse', 't')`,
		`INSERT INTO decisions (meeting_id, content, timestamp) VALUES ('m1', 'd', 't')`,
		`INSERT INTO tasks (id, status, source_meeting_id, created_at, updated_at) VALUES ('t1', 'pending', 'm1', 't', 't')`,
		`INSERT INTO global_messages (sender, text, timestamp) VALUES ('claude:1', 'g', 't')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	count := func(q string) int {
		t.Helper()
		var n int
		if err := s.DB.QueryRow(q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for q, want := range map[string]int{
		`SELECT COUNT(*) FROM meetings WHERE id = 'm1' AND end_reason = 'consensus' AND reopened_at IS NULL`: 1,
		`SELECT COUNT(*) FROM meeting_messages WHERE meeting_id = 'm1'`:                                      2,
		`SELECT COUNT(*) FROM meeting_approvers`:                                                             1,
		`SELECT COUNT(*) FROM meeting_stances`:                                                               1,
		`SELECT COUNT(*) FROM decisions`:                                                                     1,
		`SELECT COUNT(*) FROM tasks WHERE source_meeting_id = 'm1'`:                                          1,
		`SELECT COUNT(*) FROM meeting_messages WHERE sender_name = 'claude@p#1' AND sender_machine = 'box · WSL Ubuntu' AND snapshot_backfilled = 1`:     1,
		`SELECT COUNT(*) FROM meeting_messages WHERE sender = 'mcp-x' AND sender_name IS NULL AND snapshot_backfilled = 0`:                               1,
		`SELECT COUNT(*) FROM meeting_members WHERE name = 'claude@p#1' AND title = 'Work' AND machine = 'box · WSL Ubuntu' AND snapshot_backfilled = 1`: 1,
		`SELECT COUNT(*) FROM global_messages WHERE sender_name = 'claude@p#1' AND snapshot_backfilled = 1`:                                              1,
	} {
		if got := count(q); got != want {
			t.Errorf("%s: %d, want %d", q, got, want)
		}
	}
	// Foreign keys are on again: deleting the meeting still cascades.
	if _, err := s.DB.Exec(`DELETE FROM meetings WHERE id = 'm1'`); err != nil {
		t.Fatal(err)
	}
	if got := count(`SELECT COUNT(*) FROM meeting_messages`) + count(`SELECT COUNT(*) FROM tasks WHERE source_meeting_id IS NOT NULL`); got != 0 {
		t.Fatalf("%d rows left", got)
	}
}

// A database of an older host whose migration series was restarted (its
// user_version is within range but its schema is not the one the migrations
// expect) fails inside a migration: the error says how to reset it.
func TestMigrationFailureOnMigratedDatabaseSaysToReset(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, FileName)))
	if err != nil {
		t.Fatal(err)
	}
	// The 0.9.0 schema, as far as 0003 and 0004 touch it: agent_sessions without
	// label, meetings without current_proposal_id, at user_version 2.
	for _, q := range []string{
		`CREATE TABLE agent_sessions (
			id TEXT PRIMARY KEY,
			client TEXT NOT NULL CHECK(client IN ('claude', 'codex')),
			name TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			cwd TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('working', 'idle', 'listening', 'offline')),
			listening INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL
		)`,
		`CREATE TABLE meetings (
			id TEXT PRIMARY KEY,
			topic TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived')),
			is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
			active_order INTEGER NOT NULL,
			initiator TEXT NOT NULL,
			participants TEXT NOT NULL,
			created_at TEXT NOT NULL,
			closed_at TEXT,
			summary TEXT,
			CHECK (is_default = 0 OR status = 'active')
		)`,
		`PRAGMA user_version = 2`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	_, err = Open(dir)
	if err == nil {
		t.Fatal("opened")
	}
	for _, want := range []string{"migration 0004_retention.sql", "no such column: current_proposal_id", "delete " + FileName, "reset the data directory"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
}

// 0008 drops agent_messages.wake and keeps every direct message: in the
// inbox each one may wake its recipient, whatever wake it was sent with, and a
// broadcast delivery keeps its own wake.
func TestMigrationMessageWake(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, FileName))+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_core.sql", "0002_agents.sql", "0003_session_environment.sql", "0004_retention.sql", "0005_unread_check.sql", "0006_meeting_seat.sql", "0007_broadcast.sql"} {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, q := range []string{
		`PRAGMA user_version = 7`,
		`INSERT INTO agent_sessions (id, client, name, cwd, status, created_at, last_active_at, title, hostname, platform, utc_offset, label, environment)
			VALUES ('claude:1', 'claude', 'claude@p#1', '/p', 'idle', 't', 't', '', 'box', 'wsl', 0, '', 'Ubuntu'),
			       ('codex:2', 'codex', 'codex@p#2', '/p', 'idle', 't', 't', '', 'box', 'wsl', 0, '', 'Ubuntu')`,
		`INSERT INTO agent_messages (id, from_id, to_id, text, status, created_at, expires_at, expects_reply, wake)
			VALUES ('a', 'claude:1', 'codex:2', 'quiet', 'unread', 't', 't', 0, 0), ('b', 'codex:2', 'claude:1', 'loud', 'read', 't', 't', 1, 1)`,
		`INSERT INTO broadcasts (id, from_id, text, expects_reply, created_at, expires_at) VALUES ('c', 'claude:1', 'all', 0, 't', 't')`,
		`INSERT INTO broadcast_deliveries (broadcast_id, to_id, status, wake) VALUES ('c', 'codex:2', 'unread', 0)`,
		`INSERT INTO agent_messages (id, from_id, to_id, text, reply_to_broadcast, status, created_at, expires_at, expects_reply, wake)
			VALUES ('d', 'codex:2', 'claude:1', 'answer', 'c', 'unread', 't', 't', 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.DB.Query(`SELECT kind, id, to_id, text, reply_to, reply_kind, status, expects_reply, wake FROM agent_inbox ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var kind, id, to, text, status string
		var replyTo, replyKind sql.NullString
		var expects, wake int
		if err := rows.Scan(&kind, &id, &to, &text, &replyTo, &replyKind, &status, &expects, &wake); err != nil {
			t.Fatal(err)
		}
		got = append(got, strings.Join([]string{kind, id, to, text, replyTo.String, replyKind.String, status, string(rune('0' + expects)), string(rune('0' + wake))}, "|"))
	}
	want := []string{
		"direct|a|codex:2|quiet|||unread|0|1",
		"direct|b|claude:1|loud|||read|1|1",
		"broadcast|c|codex:2|all|||unread|0|0",
		"direct|d|claude:1|answer|c|broadcast|unread|0|1",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("inbox:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// The column is gone: a new message is written without it.
	if _, err := s.DB.Exec(`INSERT INTO agent_messages (id, from_id, to_id, text, status, created_at, expires_at, expects_reply) VALUES ('e', 'claude:1', 'codex:2', 'x', 'unread', 't', 't', 1)`); err != nil {
		t.Fatal(err)
	}
}
