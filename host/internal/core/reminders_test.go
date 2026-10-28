package core

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// draftMeeting adds a meeting whose current draft is a message of author
// posted at the harness time, with required approvers.
func (h *harness) draftMeeting(id, status string, order int, author string, approvers ...string) int64 {
	h.t.Helper()
	h.exec(`INSERT INTO meetings (id, topic, status, is_default, active_order, initiator, participants, created_at)
		VALUES (?, ?, ?, 0, ?, ?, '[]', ?)`, id, "Topic "+id, status, order, author, store.ISO(h.clock.Now()))
	draft := h.postDraft(id, author)
	for _, a := range approvers {
		h.exec(`INSERT INTO meeting_approvers (meeting_id, member_id) VALUES (?, ?)`, id, a)
	}
	return draft
}

// postDraft adds a message and makes it the meeting's current draft, resetting the reminders as publishing a draft does.
func (h *harness) postDraft(meetingID, author string) int64 {
	h.t.Helper()
	seq := h.count(`SELECT COALESCE(MAX(seq), 0) + 1 FROM meeting_messages WHERE meeting_id = ?`, meetingID)
	h.exec(`INSERT INTO meeting_messages (meeting_id, seq, sender, text, category, timestamp) VALUES (?, ?, ?, 'draft', 'PROPOSAL', ?)`,
		meetingID, seq, author, store.ISO(h.clock.Now()))
	id := int64(h.count(`SELECT MAX(id) FROM meeting_messages`))
	h.exec(`UPDATE meetings SET current_proposal_id = ?, draft_reminded_at = NULL WHERE id = ?`, id, meetingID)
	h.exec(`UPDATE meeting_approvers SET reminded_at = NULL WHERE meeting_id = ?`, meetingID)
	return id
}

func (h *harness) stance(meetingID string, draft int64, member, stance string) {
	h.t.Helper()
	h.exec(`INSERT OR REPLACE INTO meeting_stances (meeting_id, message_id, member_id, identity_kind, stance, at) VALUES (?, ?, ?, 'session', ?, ?)`,
		meetingID, draft, member, stance, store.ISO(h.clock.Now()))
}

func (h *harness) remind() string {
	h.t.Helper()
	line, err := h.core.RemindStances(context.Background(), 10*time.Minute)
	if err != nil {
		h.t.Fatal(err)
	}
	return line
}

func TestRemindStances(t *testing.T) {
	h, n := newNotedHarness(t)
	texts := h.core.d.Contract.Hook.Texts
	h.exec(`INSERT INTO agent_sessions (id, client, name, note, cwd, status, listening, created_at, last_active_at, hostname, platform, utc_offset)
		VALUES ('codex:a', 'codex', 'alice', '', '', 'idle', 0, 'x', 'x', 'box', 'linux', 0)`)
	d1 := h.draftMeeting("m1", "active", 1, "codex:author", "codex:a", "codex:b", "codex:c", "codex:d")
	h.stance("m1", d1, "codex:b", "endorse")
	h.stance("m1", d1, "codex:c", "object")
	h.draftMeeting("m2", "closed", 2, "codex:author", "codex:a")
	h.draftMeeting("m3", "active", 3, "mcp-1", "codex:x")

	// Not quiet long enough: nothing.
	h.clock.Set(start.Add(10 * time.Minute))
	if line := h.remind(); line != "" || len(n.calls) != 0 {
		t.Fatalf("early reminder %q %v", line, n.calls)
	}

	// Quiet past the limit: the approvers without a stance (not the objector or
	// the endorser) and, once, the draft's author when it is a session.
	h.clock.Set(start.Add(11 * time.Minute))
	if line := h.remind(); line != "stance reminders: 3 approvers and 1 draft authors in 2 meetings" {
		t.Fatalf("line %q", line)
	}
	want := []string{
		fmt.Sprintf("notice m1 [codex:a codex:d] %s", fmt.Sprintf(texts.StanceReminder, "Topic m1", "m1", 1, 1)),
		fmt.Sprintf("notice m1 [codex:author] %s", fmt.Sprintf(texts.StanceWaiting, "Topic m1", "m1", 1, "alice (codex:a), codex:c (objected), codex:d")),
		fmt.Sprintf("notice m3 [codex:x] %s", fmt.Sprintf(texts.StanceReminder, "Topic m3", "m3", 1, 1)),
	}
	if !slices.Equal(n.calls, want) {
		t.Fatalf("calls\n%v\nwant\n%v", n.calls, want)
	}
	if got := h.count(`SELECT COUNT(*) FROM meeting_approvers WHERE reminded_at IS NOT NULL`); got != 3 {
		t.Fatalf("reminded %d", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM meetings WHERE draft_reminded_at IS NOT NULL`); got != 2 {
		t.Fatalf("drafts reminded %d", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM meetings WHERE status = 'active'`); got != 2 {
		t.Fatalf("meetings changed: %d active", got)
	}

	// Once per draft.
	n.calls = nil
	h.clock.Set(start.Add(30 * time.Minute))
	if line := h.remind(); line != "" || len(n.calls) != 0 {
		t.Fatalf("repeated %q %v", line, n.calls)
	}

	// A new draft: who endorsed it is not reminded; reminders wait for the meeting to be quiet again.
	d2 := h.postDraft("m1", "codex:author")
	h.stance("m1", d2, "codex:a", "endorse")
	h.clock.Set(start.Add(35 * time.Minute))
	if line := h.remind(); line != "" {
		t.Fatalf("early reminder %q", line)
	}
	h.clock.Set(start.Add(41 * time.Minute))
	h.remind()
	want = []string{
		fmt.Sprintf("notice m1 [codex:b codex:c codex:d] %s", fmt.Sprintf(texts.StanceReminder, "Topic m1", "m1", 2, 2)),
		fmt.Sprintf("notice m1 [codex:author] %s", fmt.Sprintf(texts.StanceWaiting, "Topic m1", "m1", 2, "codex:b, codex:c, codex:d")),
	}
	if !slices.Equal(n.calls, want) {
		t.Fatalf("calls\n%v\nwant\n%v", n.calls, want)
	}

	// Everyone endorsed: nothing to remind.
	n.calls = nil
	d3 := h.postDraft("m1", "codex:author")
	for _, a := range []string{"codex:a", "codex:b", "codex:c", "codex:d"} {
		h.stance("m1", d3, a, "endorse")
	}
	h.clock.Set(start.Add(time.Hour))
	if line := h.remind(); line != "" || len(n.calls) != 0 {
		t.Fatalf("endorsed draft reminded %q %v", line, n.calls)
	}
}

func TestRemindStancesWithoutNotifier(t *testing.T) {
	h := newHarness(t)
	h.draftMeeting("m1", "active", 1, "codex:author", "codex:a")
	h.clock.Set(start.Add(time.Hour))
	if line := h.remind(); line == "" {
		t.Fatal("no reminder")
	}
	if got := h.count(`SELECT COUNT(*) FROM meeting_approvers WHERE reminded_at IS NOT NULL`); got != 1 {
		t.Fatalf("reminded %d", got)
	}
}
