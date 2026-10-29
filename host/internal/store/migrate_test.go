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
