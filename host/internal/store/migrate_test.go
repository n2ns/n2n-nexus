package store

import (
	"database/sql"
	"path/filepath"
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
