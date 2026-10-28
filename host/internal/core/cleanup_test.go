package core

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

const day = 24 * time.Hour

func (h *harness) cleanup(dryRun bool) cleanupReport {
	h.t.Helper()
	res := h.ok("host_maintenance", map[string]any{"action": "cleanup", "dryRun": dryRun}, "admin")
	raw, _ := json.Marshal(res["cleanup"])
	var r cleanupReport
	if err := json.Unmarshal(raw, &r); err != nil {
		h.t.Fatal(err)
	}
	return r
}

func meetingActions(r cleanupReport) []string {
	var out []string
	for _, m := range r.Meetings {
		out = append(out, m.Topic+" "+m.Action)
	}
	return out
}

func TestCleanupMeetings(t *testing.T) {
	h, n := newNotedHarness(t)
	at := func(d time.Duration) { h.clock.Set(start.Add(d)) }
	meeting := func(topic string) string {
		return h.ok("start_meeting", map[string]any{"topic": topic}, "a")["meetingId"].(string)
	}
	stale := meeting("stale")
	h.ok("send_message", map[string]any{"meetingId": stale, "message": "hello"}, "a")
	busy := meeting("busy")
	done := meeting("done")
	h.exec(`INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES ('a', 'meeting', ?, 0, '')`, done)
	archived := meeting("archived")
	reopened := meeting("reopened")
	h.ok("end_meeting", map[string]any{"meetingId": reopened}, "a")
	at(1 * day)
	h.ok("end_meeting", map[string]any{"meetingId": done, "summary": "ok"}, "a")
	at(2 * day)
	h.ok("end_meeting", map[string]any{"meetingId": archived}, "a")
	h.ok("archive_meeting", map[string]any{"meetingId": archived}, "a")
	at(20 * day)
	h.ok("send_message", map[string]any{"meetingId": busy, "message": "still here"}, "a")
	at(25 * day)
	h.ok("reopen_meeting", map[string]any{"meetingId": reopened}, "a")

	// 30 days without a message to the millisecond: not yet.
	at(30 * day)
	if r := h.cleanup(false); len(r.Meetings) != 0 {
		t.Fatalf("at the boundary: %v", meetingActions(r))
	}
	at(31*day + time.Hour)
	before := h.count(`SELECT COUNT(*) FROM meetings`)
	events := len(h.eventActions(""))
	n.calls = nil
	dry := h.cleanup(true)
	if !dry.DryRun || !slices.Equal(meetingActions(dry), []string{"stale expire", "done delete"}) {
		t.Fatalf("dry run: %+v", dry)
	}
	if h.count(`SELECT COUNT(*) FROM meetings`) != before || h.count(`SELECT COUNT(*) FROM meetings WHERE status = 'active'`) != 3 ||
		len(h.eventActions("")) != events || len(n.calls) != 0 {
		t.Fatal("the dry run changed something", h.count(`SELECT COUNT(*) FROM meetings WHERE status = 'active'`), n.calls)
	}

	cleanups := len(h.eventActions("maintenance"))
	r := h.cleanup(false)
	if r.DryRun || !slices.Equal(meetingActions(r), meetingActions(dry)) || r.Counts.MeetingsExpired != 1 || r.Counts.Meetings != 1 {
		t.Fatalf("cleanup: %+v", r)
	}
	var status, reason, summary string
	if err := h.store.DB.QueryRow(`SELECT status, end_reason, summary FROM meetings WHERE id = ?`, stale).Scan(&status, &reason, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "closed" || reason != "expired" || !strings.Contains(summary, "30 days without a message") {
		t.Fatal(status, reason, summary)
	}
	if h.count(`SELECT COUNT(*) FROM meetings WHERE id = ?`, done) != 0 ||
		h.count(`SELECT COUNT(*) FROM read_cursors WHERE context_id = ?`, done) != 0 {
		t.Fatal("done is still there")
	}
	if !slices.Equal(n.calls, []string{"closed " + stale + " 1"}) {
		t.Fatalf("notified: %v", n.calls)
	}
	if got := h.eventActions("maintenance"); len(got) != cleanups+1 {
		t.Fatalf("events: %v", got)
	}

	// Running it again changes nothing and records nothing.
	if r := h.cleanup(false); r.Counts.total() != 0 || len(h.eventActions("maintenance")) != cleanups+1 {
		t.Fatalf("second run: %+v", r)
	}
	// The archived meeting goes 30 days after it was ended, the expired one 30 days after it closed.
	at(32*day + time.Hour)
	if r := h.cleanup(false); !slices.Equal(meetingActions(r), []string{"archived delete"}) {
		t.Fatalf("%v", meetingActions(r))
	}
	at(61*day + 2*time.Hour)
	if r := h.cleanup(false); !slices.Equal(meetingActions(r), []string{"busy expire", "reopened expire", "stale delete"}) {
		t.Fatalf("%v", meetingActions(r))
	}
}

func TestExportMeeting(t *testing.T) {
	h := newHarness(t)
	id := h.ok("start_meeting", map[string]any{"topic": "Plan"}, "a")["meetingId"].(string)
	h.ok("send_message", map[string]any{"meetingId": id, "message": "first point", "category": "UPDATE"}, "a")
	h.exec(`UPDATE meeting_messages SET sender_name = 'claude@x#1', sender_machine = 'Box · Linux', snapshot_backfilled = 1 WHERE meeting_id = ? AND seq = 1`, id)
	h.ok("end_meeting", map[string]any{"meetingId": id, "summary": "done"}, "a")
	md := h.ok("host_maintenance", map[string]any{"action": "export", "meetingId": id}, "admin")["markdown"].(string)
	for _, want := range []string{"# Plan\n", "- Status: closed (manual)", "- Summary: done", "## Members\n\n- a, joined ",
		"### #1 claude@x#1 (Box · Linux)\\* · ", " · UPDATE\n\nfirst point\n", "recorded when the database was upgraded"} {
		if !strings.Contains(md, want) {
			t.Fatalf("missing %q in:\n%s", want, md)
		}
	}
	h.fails(400, "needs meetingId", "host_maintenance", map[string]any{"action": "export"}, "admin")
	h.fails(400, "not found", "host_maintenance", map[string]any{"action": "export", "meetingId": "nope"}, "admin")
}

// A member shows the session as it was when it joined: changing how it takes
// part keeps that, coming back after leaving joins anew.
func TestMemberSnapshotIsFromTheJoin(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.exec(`INSERT INTO agent_sessions (id, client, name, cwd, status, created_at, last_active_at, hostname, platform, utc_offset) VALUES ('codex:a', 'codex', 'alice', '/w', 'idle', 'x', 'x', 'box', 'linux', 0)`)
	id := h.ok("start_meeting", map[string]any{"topic": "T"}, "admin")["meetingId"].(string)
	name := func() string {
		var n string
		if err := h.store.DB.QueryRow(`SELECT name FROM meeting_members WHERE meeting_id = ? AND member_id = 'codex:a'`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	h.as("a", "join_meeting", map[string]any{"meetingId": id})
	h.exec(`UPDATE agent_sessions SET name = 'alice2' WHERE id = 'codex:a'`)
	h.as("a", "join_meeting", map[string]any{"meetingId": id, "mode": "async"})
	if got := name(); got != "alice" {
		t.Fatalf("after a mode change: %s", got)
	}
	h.as("a", "leave_meeting", map[string]any{"meetingId": id})
	h.as("a", "join_meeting", map[string]any{"meetingId": id})
	if got := name(); got != "alice2" {
		t.Fatalf("after joining again: %s", got)
	}
}
