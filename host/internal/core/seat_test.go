package core

import (
	"fmt"
	"strings"
	"testing"
)

// seatMeeting starts a meeting with a in the user's seat and b, c as required members, everyone caught up.
func seatMeeting(t *testing.T) (*harness, string) {
	h := newHarnessWith(t, fakeIdentities{})
	for _, s := range []string{"a", "b", "c"} {
		h.exec(`INSERT INTO agent_sessions (id, client, name, cwd, status, created_at, last_active_at, hostname, platform, utc_offset) VALUES (?, 'codex', ?, '/w', 'idle', 'x', 'x', 'box', 'linux', 0)`,
			"codex:"+s, "name-"+s)
	}
	id := h.as("a", "start_meeting", map[string]any{"topic": "Seated", "seat": "user"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id, "since": "beginning"})
	h.as("c", "join_meeting", map[string]any{"meetingId": id, "since": "beginning"})
	return h, id
}

func (h *harness) post(session, meetingID, text string, draft bool) map[string]any {
	h.t.Helper()
	h.catchUpAs(session, meetingID)
	return h.as(session, "send_message", map[string]any{"meetingId": meetingID, "message": text, "draft": draft})
}

func TestSeatIsTakenAndMoves(t *testing.T) {
	h, id := seatMeeting(t)
	texts := h.core.d.Contract.Hook.Texts
	if from, _, text := h.lastMessage(id); from != "n2n-nexus" || !strings.HasPrefix(text, fmt.Sprintf(texts.SeatTaken, "name-a (codex:a)")) {
		t.Fatalf("taken %s %q", from, text)
	}
	if m := h.listing(id); m.Seat == nil || *m.Seat != "codex:a" {
		t.Fatalf("seat %+v", m)
	}
	// The seat's messages name it as the seat.
	h.post("a", id, "hello", false)
	msgs := h.ok("read_messages", map[string]any{"meetingId": id, "latest": true, "count": 1}, "")["messages"].([]any)
	if got := msgs[0].(map[string]any)["senderName"]; got != fmt.Sprintf(texts.SeatSender, "name-a") {
		t.Fatalf("sender %v", got)
	}
	// b takes the seat; a stays a member as it was.
	h.as("b", "join_meeting", map[string]any{"meetingId": id, "seat": "user"})
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.SeatMoved, "name-a (codex:a)", "name-b (codex:b)") {
		t.Fatalf("moved %q", text)
	}
	if m := h.listing(id); *m.Seat != "codex:b" {
		t.Fatalf("seat %+v", m)
	}
	if n := h.count(`SELECT COUNT(*) FROM meeting_members WHERE member_id = 'codex:a' AND left_at IS NULL AND mode = 'active'`); n != 1 {
		t.Fatal("a left the meeting")
	}
	// Taking it again changes nothing; an instance cannot take it.
	before := h.count(`SELECT COUNT(*) FROM meeting_messages`)
	h.as("b", "join_meeting", map[string]any{"meetingId": id, "seat": "user"})
	if h.count(`SELECT COUNT(*) FROM meeting_messages`) != before {
		t.Fatal("a second seat message")
	}
	h.fails(400, "a conversation with the n2n-nexus hooks", "join_meeting", map[string]any{"meetingId": id, "seat": "user"}, "mcp-x")
}

func TestOnlyTheSeatEndsTheMeeting(t *testing.T) {
	h, id := seatMeeting(t)
	r := h.callAs("end_meeting", map[string]any{"meetingId": id, "summary": "we are done"}, "mcp-1", codex("b"))
	res := map[string]any{}
	decode(t, r.result, &res)
	if res["ok"] != false || res["refused"] != true || res["status"] != "active" {
		t.Fatalf("not refused %v", res)
	}
	if from, _, text := h.lastMessage(id); from != "codex:b" || text != fmt.Sprintf(h.core.d.Contract.Hook.Texts.ProposedEnd, "we are done") ||
		res["messageId"] != float64(h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)) {
		t.Fatalf("proposal %s %q %v", from, text, res)
	}
	h.failsAs("a", "with a summary", "end_meeting", map[string]any{"meetingId": id})
	if res := h.as("a", "end_meeting", map[string]any{"meetingId": id, "summary": "decided 1; open: point 2; b writes it"}); res["status"] != "closed" {
		t.Fatalf("end %v", res)
	}
}

func TestSeatDecidesTheDraft(t *testing.T) {
	h, id := seatMeeting(t)
	texts := h.core.d.Contract.Hook.Texts
	h.post("b", id, "Decision point 1/2: plan A", true) // #3
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)

	// The AI consensus is told when reached, lost and reached again; it decides nothing.
	h.stanceAs("b", id, draft, "endorse", "")
	h.stanceAs("c", id, draft, "endorse", "")
	aiConsensus := fmt.Sprintf(texts.AiConsensus, draft, "codex:b, codex:c")
	if _, _, text := h.lastMessage(id); text != aiConsensus || h.listing(id).Status != "active" {
		t.Fatalf("consensus %q", text)
	}
	h.stanceAs("c", id, draft, "withdraw", "")
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.AiConsensusLost, draft) {
		t.Fatalf("lost %q", text)
	}
	h.stanceAs("c", id, draft, "object", "实测：plan A breaks the build")
	h.stanceAs("c", id, draft, "endorse", "fixed, see #3")
	if _, _, text := h.lastMessage(id); text != aiConsensus {
		t.Fatalf("again %q", text)
	}
	consensusPosts := h.count(`SELECT COUNT(*) FROM meeting_messages WHERE text = ?`, aiConsensus)
	h.stanceAs("b", id, draft, "endorse", "still")
	if h.count(`SELECT COUNT(*) FROM meeting_messages WHERE text = ?`, aiConsensus) != consensusPosts {
		t.Fatal("consensus told twice")
	}
	appr := h.stanceAs("a", id, draft, "endorse", "go")["approvals"].(map[string]any)
	if fmt.Sprint(appr["required"]) != "[]" {
		t.Fatalf("approvals after the decision %v", appr)
	}
	from, category, text := h.lastMessage(id)
	if want := fmt.Sprintf(texts.SeatDecision, draft, "name-a (codex:a)", ": go", "", "Decision point 1/2: plan A"); from != "n2n-nexus" || category != "DECISION" || text != want {
		t.Fatalf("decision %s %s %q", from, category, text)
	}
	m := h.listing(id)
	if m.Status != "active" || m.Proposal != nil || h.count(`SELECT COUNT(*) FROM decisions`) != 1 {
		t.Fatalf("after the decision %+v", m)
	}
	// Endorsing the same draft again decides nothing more.
	if res := h.stanceAs("a", id, draft, "endorse", "go"); res["decisionId"] != nil || h.count(`SELECT COUNT(*) FROM decisions`) != 1 {
		t.Fatalf("decided twice %v", res)
	}

	// The next draft: open objections are listed in the decision; the seat's object vetoes, without grounds, even with unread messages.
	h.post("b", id, "Decision point 2/2: plan B", true)
	next := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.stanceAs("c", id, next, "object", "see docs/plan.md")
	h.post("b", id, "unread for a", false)
	res := h.as("a", "stance", map[string]any{"meetingId": id, "messageId": next, "stance": "object", "note": "not now"})
	if res["ok"] != true || res["unread"] == nil || res["currentProposalId"] != nil {
		t.Fatalf("veto %v", res)
	}
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.SeatVeto, next, "name-a (codex:a)", "not now") {
		t.Fatalf("veto %q", text)
	}
	if h.listing(id).Proposal != nil {
		t.Fatal("vetoed draft is still current")
	}
	// A draft decided over an open objection lists it.
	h.post("b", id, "plan C", true)
	last := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.stanceAs("c", id, last, "object", "https://example.com/issue")
	h.stanceAs("a", id, last, "endorse", "")
	if _, _, text := h.lastMessage(id); !strings.Contains(text, fmt.Sprintf(texts.SeatOpenObjections, "codex:c: https://example.com/issue")) {
		t.Fatalf("open objections %q", text)
	}
}

func TestStanceGroundsAndChanges(t *testing.T) {
	h, id := seatMeeting(t)
	h.post("a", id, "a draft", true)
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	stance := func(s, note string) map[string]any {
		return map[string]any{"meetingId": id, "messageId": draft, "stance": s, "note": note}
	}
	h.catchUpAs("b", id)
	h.failsAs("b", "needs its grounds", "stance", stance("object", "no"))
	h.failsAs("b", "[#99] are not messages", "stance", stance("object", "see #99"))
	for _, note := range []string{"see #1", "host/internal/core/seat.go", "settings.go", "https://x.test/a", "数据：3 of 5", "It fails. Measured: 2s"} {
		h.as("b", "stance", stance("object", note))
	}
	// Two changes, then the stance is fixed; withdraw still works and does not reset it.
	h.as("b", "stance", stance("endorse", "#1 is answered"))
	h.as("b", "stance", stance("object", "#1 again"))
	h.failsAs("b", "is fixed after 2 changes", "stance", stance("endorse", "#1"))
	h.as("b", "stance", stance("withdraw", ""))
	h.failsAs("b", "is fixed after 2 changes", "stance", stance("endorse", "#1"))
	h.as("b", "stance", stance("object", "same as before, #1"))
	// The first endorsement needs no grounds.
	h.catchUpAs("c", id)
	h.as("c", "stance", stance("endorse", ""))
	// The seat is not reminded of its stance.
	h.exec(`UPDATE meeting_messages SET timestamp = '2000-01-01T00:00:00.000Z' WHERE meeting_id = ?`, id)
	h.core.RemindStances(t.Context(), 0)
	if n := h.count(`SELECT COUNT(*) FROM meeting_approvers WHERE member_id = 'codex:a' AND reminded_at IS NOT NULL`); n != 0 {
		t.Fatal("the seat was reminded")
	}
}

// A meeting keeps the seat's rules after the seat's session was cleaned up
// (the agents' cleanup deletes the session with its read cursors; the
// meeting's member row stays): nobody else ends it, and another session
// takes the seat and decides.
func TestSeatOutlivesItsSession(t *testing.T) {
	h, id := seatMeeting(t)
	texts := h.core.d.Contract.Hook.Texts
	h.post("b", id, "plan", true)
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.exec(`DELETE FROM read_cursors WHERE instance_id = 'codex:a'`)
	h.exec(`DELETE FROM agent_sessions WHERE id = 'codex:a'`)
	h.refusedAs("b", "end_meeting", map[string]any{"meetingId": id, "summary": "done"})
	if m := h.listing(id); m.Status != "active" || *m.Seat != "codex:a" {
		t.Fatalf("after cleanup %+v", m)
	}
	h.as("c", "join_meeting", map[string]any{"meetingId": id, "seat": "user"})
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.SeatMoved, "name-a (codex:a)", "name-c (codex:c)") {
		t.Fatalf("moved %q", text)
	}
	if res := h.stanceAs("c", id, draft, "endorse", "go"); res["decisionId"] == nil {
		t.Fatalf("the new seat did not decide %v", res)
	}
}

// Taking the seat changes who counts for the AI consensus: its state is told anew.
func TestSeatMoveRechecksConsensus(t *testing.T) {
	h, id := seatMeeting(t)
	texts := h.core.d.Contract.Hook.Texts
	h.post("b", id, "plan", true)
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.stanceAs("b", id, draft, "endorse", "")
	h.stanceAs("c", id, draft, "endorse", "")
	// c takes the seat: a, who has not endorsed, now counts: lost.
	h.as("c", "join_meeting", map[string]any{"meetingId": id, "seat": "user"})
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.AiConsensusLost, draft) {
		t.Fatalf("after the move %q", text)
	}
	h.stanceAs("a", id, draft, "endorse", "")
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.AiConsensus, draft, "codex:a, codex:b") {
		t.Fatalf("restored %q", text)
	}
}

func TestGroundsFormat(t *testing.T) {
	h, id := seatMeeting(t)
	h.post("a", id, "a draft", true)
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.catchUpAs("b", id)
	for _, note := range []string{"决策点 1/2 不行", "and/or not", "N/A"} {
		h.failsAs("b", "needs its grounds", "stance", map[string]any{"meetingId": id, "messageId": draft, "stance": "object", "note": note})
	}
	for _, note := range []string{"见 docs/方案.md", "见 ~/notes/x", "方案.md"} {
		h.as("b", "stance", map[string]any{"meetingId": id, "messageId": draft, "stance": "object", "note": note})
	}
}

// A change of the approvers in a seated meeting is told without the seat,
// which is in none of the approver lists.
func TestApproversChangedLeavesOutTheSeat(t *testing.T) {
	h, id := seatMeeting(t)
	texts := h.core.d.Contract.Hook.Texts
	h.post("b", id, "plan", true)
	draft := h.count(`SELECT MAX(seq) FROM meeting_messages WHERE meeting_id = ?`, id)
	h.as("c", "leave_meeting", map[string]any{"meetingId": id})
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.ApproversChanged, draft, 2, "codex:b") {
		t.Fatalf("change %q", text)
	}
	if m := h.listing(id); fmt.Sprint(m.Proposal.Required) != "[codex:b]" {
		t.Fatalf("required %v", m.Proposal.Required)
	}
}

// Reading a meeting (unread mode) also announces what was read: the next
// notification does not repeat it.
func TestReadingAMeetingAnnouncesIt(t *testing.T) {
	h, id := seatMeeting(t)
	h.post("a", id, "one", false)
	h.post("a", id, "two", false)
	h.as("b", "read_messages", map[string]any{"meetingId": id})
	if got, want := h.count(`SELECT notified_id FROM meeting_members WHERE meeting_id = ? AND member_id = 'codex:b'`, id), h.count(`SELECT MAX(id) FROM meeting_messages WHERE meeting_id = ?`, id); got != want {
		t.Fatalf("notified_id %d, want %d", got, want)
	}
	// Not back: a history read moves nothing.
	h.exec(`UPDATE meeting_members SET notified_id = 1 WHERE meeting_id = ? AND member_id = 'codex:b'`, id)
	h.as("b", "read_messages", map[string]any{"meetingId": id, "latest": true})
	if got := h.count(`SELECT notified_id FROM meeting_members WHERE meeting_id = ? AND member_id = 'codex:b'`, id); got != 1 {
		t.Fatalf("history read announced %d", got)
	}
}
