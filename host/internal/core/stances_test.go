package core

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

// meetingListing is one meeting of list_meetings, decoded.
type meetingListing struct {
	ID        string  `json:"id"`
	Status    string  `json:"status"`
	EndReason *string `json:"endReason"`
	Seat      *string `json:"seat"`
	Proposal  *struct {
		MessageID        int64       `json:"messageId"`
		Author           string      `json:"author"`
		ApproversVersion int64       `json:"approversVersion"`
		Required         []string    `json:"required"`
		Endorsed         []string    `json:"endorsed"`
		Waiting          []string    `json:"waiting"`
		Objections       []objection `json:"objections"`
	} `json:"proposal"`
}

func (h *harness) listing(meetingID string) meetingListing {
	h.t.Helper()
	var out struct {
		Meetings []meetingListing `json:"meetings"`
	}
	json.Unmarshal(h.call("list_meetings", map[string]any{}, "").result, &out)
	for _, m := range out.Meetings {
		if m.ID == meetingID {
			return m
		}
	}
	h.t.Fatalf("meeting %s not listed", meetingID)
	return meetingListing{}
}

// lastMessage is the newest message of a meeting: sender, category and text.
func (h *harness) lastMessage(meetingID string) (from, category, text string) {
	h.t.Helper()
	msgs := h.ok("read_messages", map[string]any{"meetingId": meetingID, "latest": true, "count": 1}, "")["messages"].([]any)
	m := msgs[0].(map[string]any)
	category, _ = m["category"].(string)
	return m["from"].(string), category, m["text"].(string)
}

// stanceAs takes a stance as a Codex session, after reading what is unread.
func (h *harness) stanceAs(session string, meetingID string, messageID int, stance, note string) map[string]any {
	h.t.Helper()
	h.catchUpAs(session, meetingID)
	args := map[string]any{"meetingId": meetingID, "messageId": messageID, "stance": stance}
	if note != "" {
		args["note"] = note
	}
	return h.as(session, "stance", args)
}

// failsAs calls a tool as a Codex session; it must fail with 400 and an error containing want.
func (h *harness) failsAs(session, want, tool string, args map[string]any) {
	h.t.Helper()
	r := h.callAs(tool, args, "mcp-1", codex(session))
	if r.status != 400 || !strings.Contains(r.err, want) {
		h.t.Fatalf("%s: got %d %q, want 400 containing %q", tool, r.status, r.err, want)
	}
}

func TestDraftSetsTheCurrentProposalAndItsApprovers(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.fails(400, "A draft is published to a meeting", "send_message", map[string]any{"message": "x", "draft": true}, "mcp-0")
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("c", "join_meeting", map[string]any{"meetingId": id, "mode": "async"})                // optional
	h.ok("join_meeting", map[string]any{"meetingId": id, "approver": "required"}, "mcp-plain") // an instance
	h.as("d", "join_meeting", map[string]any{"meetingId": id})
	h.as("d", "leave_meeting", map[string]any{"meetingId": id})

	// A PROPOSAL without draft is no draft.
	if res := h.as("b", "send_message", map[string]any{"meetingId": id, "message": "idea", "category": "PROPOSAL"}); res["currentProposalId"] != nil {
		t.Fatalf("plain proposal %v", res)
	}
	if m := h.listing(id); m.Proposal != nil || m.EndReason != nil {
		t.Fatalf("no draft yet %+v", m)
	}
	h.failsAs("a", "A draft is a PROPOSAL", "send_message", map[string]any{"meetingId": id, "message": "x", "draft": true, "category": "CHAT"})

	h.catchUpAs("a", id)
	res := h.as("a", "send_message", map[string]any{"meetingId": id, "message": "plan v1", "draft": true})
	if res["currentProposalId"] != 2.0 || res["messageId"] != 2.0 {
		t.Fatalf("draft %v", res)
	}
	if _, category, _ := h.lastMessage(id); category != "PROPOSAL" {
		t.Fatalf("draft category %q", category)
	}
	p := h.listing(id).Proposal
	if p == nil || p.MessageID != 2 || p.Author != "codex:a" || p.ApproversVersion != 1 ||
		!slices.Equal(p.Required, []string{"codex:a", "codex:b"}) || !slices.Equal(p.Waiting, []string{"codex:a", "codex:b"}) ||
		len(p.Endorsed) != 0 || len(p.Objections) != 0 {
		t.Fatalf("proposal %+v", p)
	}

	// A plain PROPOSAL keeps the draft and its stances.
	h.stanceAs("b", id, 2, "endorse", "")
	h.catchUpAs("c", id)
	h.as("c", "send_message", map[string]any{"meetingId": id, "message": "other idea", "category": "PROPOSAL"})
	if p := h.listing(id).Proposal; p.MessageID != 2 || p.ApproversVersion != 1 || !slices.Equal(p.Endorsed, []string{"codex:b"}) {
		t.Fatalf("after a plain proposal %+v", p)
	}
	// A new draft replaces it: a new list version, no stances.
	h.exec(`UPDATE meetings SET draft_reminded_at = 'x' WHERE id = ?`, id)
	h.exec(`UPDATE meeting_approvers SET reminded_at = 'x' WHERE meeting_id = ?`, id)
	h.catchUpAs("b", id)
	if res := h.as("b", "send_message", map[string]any{"meetingId": id, "message": "plan v2", "draft": true, "category": "PROPOSAL"}); res["currentProposalId"] != 4.0 {
		t.Fatalf("second draft %v", res)
	}
	if p := h.listing(id).Proposal; p.MessageID != 4 || p.Author != "codex:b" || p.ApproversVersion != 2 || len(p.Endorsed) != 0 ||
		!slices.Equal(p.Required, []string{"codex:a", "codex:b"}) {
		t.Fatalf("second draft %+v", p)
	}
	if n := h.count(`SELECT COUNT(*) FROM meeting_approvers WHERE reminded_at IS NOT NULL`) +
		h.count(`SELECT COUNT(*) FROM meetings WHERE draft_reminded_at IS NOT NULL`); n != 0 {
		t.Fatalf("%d reminders kept", n)
	}
}

func TestStances(t *testing.T) {
	h, n := newNotedHarness(t)
	texts := h.core.d.Contract.Hook.Texts
	id := h.as("a", "start_meeting", map[string]any{"topic": "Plan"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "ship friday", "draft": true}) // #1
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "plain"})                      // #2

	stance := func(messageID int, stance string) map[string]any {
		return map[string]any{"meetingId": id, "messageId": messageID, "stance": stance}
	}
	h.failsAs("b", "is not a PROPOSAL", "stance", stance(2, "endorse"))
	h.failsAs("b", "has no message 9", "stance", stance(9, "endorse"))
	h.failsAs("b", "needs a note", "stance", stance(1, "object"))
	h.failsAs("b", "no stance on message 1 to withdraw", "stance", stance(1, "withdraw"))
	h.failsAs("b", "Meeting 'nope' not found.", "stance", map[string]any{"meetingId": "nope", "messageId": 1, "stance": "endorse"})

	n.calls = nil
	res := h.stanceAs("b", id, 1, "endorse", "")
	if res["counted"] != true || res["decided"] != false || res["currentProposalId"] != 1.0 || res["stance"] != "endorse" {
		t.Fatalf("endorse %v", res)
	}
	appr := res["approvals"].(map[string]any)
	if fmt.Sprint(appr["required"], appr["endorsed"], appr["waiting"], appr["objections"]) != "[codex:a codex:b] [codex:b] [codex:a] []" {
		t.Fatalf("approvals %v", appr)
	}
	// The author is told; an endorsement writes no meeting message.
	notice := func(verb, note string) string {
		return fmt.Sprintf("notice %s [codex:a] %s", id, fmt.Sprintf(texts.StanceNotice, "b", verb, 1, "Plan", id, note))
	}
	if want := []string{notice("endorsed", "")}; !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}

	// An objection replaces the endorsement and is posted to the meeting.
	n.calls = nil
	res = h.stanceAs("b", id, 1, "object", "too early, see #1")
	appr = res["approvals"].(map[string]any)
	if fmt.Sprint(appr["endorsed"], appr["waiting"], appr["objections"]) != "[] [codex:a] [map[id:codex:b note:too early, see #1]]" {
		t.Fatalf("approvals %v", appr)
	}
	if from, category, text := h.lastMessage(id); from != "codex:b" || category != "CHAT" || text != "Objection to draft #1: too early, see #1" {
		t.Fatalf("objection message %s %s %q", from, category, text)
	}
	if want := []string{notice("objected to", ": too early, see #1"), fmt.Sprintf("updated %s 3", id)}; !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}
	if c := h.count(`SELECT COUNT(*) FROM meeting_stances`); c != 1 {
		t.Fatalf("%d stances", c)
	}

	// The author's own stance tells nobody; an objection blocks the consensus.
	n.calls = nil
	if res := h.stanceAs("a", id, 1, "endorse", ""); res["decided"] != false {
		t.Fatalf("decided over an objection %v", res)
	}
	if len(n.calls) != 0 {
		t.Fatalf("notifier %v", n.calls)
	}
	// Withdrawing the objection leaves b without a stance.
	res = h.stanceAs("b", id, 1, "withdraw", "")
	if appr := res["approvals"].(map[string]any); fmt.Sprint(appr["waiting"], appr["objections"]) != "[codex:b] []" || res["decided"] != false {
		t.Fatalf("withdraw %v", res)
	}
	if want := []string{notice("withdrew their stance on", "")}; !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}

	// The last required endorsement decides.
	n.calls = nil
	h.clock.Set(start.Add(time.Minute))
	res = h.stanceAs("b", id, 1, "endorse", "fine after #3")
	if res["decided"] != true {
		t.Fatalf("not decided %v", res)
	}
	from, category, text := h.lastMessage(id)
	if want := fmt.Sprintf(texts.ConsensusDecision, 1, "codex:a, codex:b", "ship friday"); from != "n2n-nexus" || category != "DECISION" || text != want {
		t.Fatalf("decision %s %s %q", from, category, text)
	}
	if want := []string{notice("endorsed", ": fine after #3"), fmt.Sprintf("updated %s 4", id), fmt.Sprintf("closed %s 4", id)}; !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}
	m := h.listing(id)
	if m.Status != "closed" || m.EndReason == nil || *m.EndReason != "consensus" || m.Proposal == nil || len(m.Proposal.Waiting) != 0 {
		t.Fatalf("closed %+v", m)
	}
	if d := h.count(`SELECT COUNT(*) FROM decisions WHERE meeting_id = ?`, id); d != 1 {
		t.Fatalf("%d decisions", d)
	}
	if h.activeMeeting() != nil {
		t.Fatal("decided meeting is still the default")
	}
	ev := h.ok("list_events", map[string]any{"action": "meeting.end"}, "")["events"].([]any)[0].(map[string]any)
	if d := ev["detail"].(map[string]any); ev["actor"] != "codex:b" || d["reason"] != "consensus" || d["topic"] != "Plan" {
		t.Fatalf("event %v", ev)
	}
	// A repeated last vote does not decide twice.
	h.failsAs("a", "is closed, cannot take a stance", "stance", stance(1, "endorse"))

	// Reopening clears the end reason and the draft: a reopened meeting decides on a new one.
	h.as("a", "reopen_meeting", map[string]any{"meetingId": id})
	if m := h.listing(id); m.EndReason != nil || m.Proposal != nil {
		t.Fatalf("reopened %+v", m)
	}
	h.as("a", "end_meeting", map[string]any{"meetingId": id})
	if m := h.listing(id); m.EndReason == nil || *m.EndReason != "manual" {
		t.Fatalf("ended %+v", m)
	}
}

func TestConsensusNeedsTwoRequiredApprovers(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id, "mode": "async"}) // optional
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	h.stanceAs("b", id, 1, "endorse", "")
	if res := h.stanceAs("a", id, 1, "endorse", ""); res["decided"] != false {
		t.Fatalf("decided with one approver %v", res)
	}
	if m := h.listing(id); m.Status != "active" {
		t.Fatalf("status %s", m.Status)
	}
}

func TestInstanceStancesAreNotCounted(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.ok("join_meeting", map[string]any{"meetingId": id}, "mcp-plain")
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	h.catchUp(id, "mcp-plain")
	res := h.ok("stance", map[string]any{"meetingId": id, "messageId": 1, "stance": "object", "note": "no, see #1"}, "mcp-plain")
	if res["counted"] != false || res["decided"] != false {
		t.Fatalf("instance stance %v", res)
	}
	// An instance's endorsement does not count, but its objection blocks until it is withdrawn.
	h.stanceAs("a", id, 1, "endorse", "")
	if res := h.stanceAs("b", id, 1, "endorse", ""); res["decided"] != false {
		t.Fatalf("decided over an objection %v", res)
	}
	if res := h.ok("stance", map[string]any{"meetingId": id, "messageId": 1, "stance": "withdraw"}, "mcp-plain"); res["decided"] != true {
		t.Fatalf("withdrawn objection %v", res)
	}
}

func TestLeavingApproverChangesTheListAndCanDecide(t *testing.T) {
	h, n := newNotedHarness(t)
	texts := h.core.d.Contract.Hook.Texts
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("c", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true}) // #1
	h.stanceAs("a", id, 1, "endorse", "")
	if res := h.stanceAs("b", id, 1, "endorse", ""); res["decided"] != false {
		t.Fatalf("decided while c waits %v", res)
	}
	n.calls = nil
	h.as("c", "leave_meeting", map[string]any{"meetingId": id})
	// #2: the change, #3: the decision.
	msgs := h.ok("read_messages", map[string]any{"meetingId": id, "afterId": 1}, "")["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages %v", msgs)
	}
	change := msgs[0].(map[string]any)
	if want := fmt.Sprintf(texts.ApproversChanged, 1, 2, "codex:a, codex:b"); change["from"] != "codex:c" || change["category"] != "CHAT" || change["text"] != want {
		t.Fatalf("change %v", change)
	}
	if msgs[1].(map[string]any)["category"] != "DECISION" {
		t.Fatalf("decision %v", msgs[1])
	}
	if want := []string{fmt.Sprintf("updated %s 3", id), fmt.Sprintf("closed %s 3", id)}; !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}
	if m := h.listing(id); m.Status != "closed" || *m.EndReason != "consensus" || m.Proposal.ApproversVersion != 2 {
		t.Fatalf("meeting %+v", m)
	}
	ev := h.ok("list_events", map[string]any{"action": "meeting.end"}, "")["events"].([]any)[0].(map[string]any)
	if ev["actor"] != "codex:c" {
		t.Fatalf("event %v", ev)
	}
}

func TestApproverChangesOfMembers(t *testing.T) {
	h, n := newNotedHarness(t)
	texts := h.core.d.Contract.Hook.Texts
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("f", "join_meeting", map[string]any{"meetingId": id, "mode": "async"}) // optional before the draft
	h.clock.Set(start.Add(time.Second))
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true}) // #1
	h.clock.Set(start.Add(2 * time.Second))
	h.as("g", "join_meeting", map[string]any{"meetingId": id, "mode": "async"}) // optional after the draft

	required := func() []string { return h.listing(id).Proposal.Required }
	version := func() int64 { return h.listing(id).Proposal.ApproversVersion }
	n.calls = nil
	// A new member is not an approver of the draft, whatever it asks.
	h.as("e", "join_meeting", map[string]any{"meetingId": id})
	h.as("g", "join_meeting", map[string]any{"meetingId": id, "approver": "required"})
	// Joining again unchanged changes nothing.
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	if got := required(); !slices.Equal(got, []string{"codex:a", "codex:b"}) || version() != 1 || len(n.calls) != 0 {
		t.Fatalf("approvers %v v%d, notifier %v", got, version(), n.calls)
	}
	// b turns optional: removed.
	h.as("b", "join_meeting", map[string]any{"meetingId": id, "approver": "optional"})
	if got := required(); !slices.Equal(got, []string{"codex:a"}) || version() != 2 {
		t.Fatalf("after optional %v v%d", got, version())
	}
	if from, _, text := h.lastMessage(id); from != "codex:b" || text != fmt.Sprintf(texts.ApproversChanged, 1, 2, "codex:a") {
		t.Fatalf("change %s %q", from, text)
	}
	// f, a member from before the draft, turns required: added.
	h.as("f", "join_meeting", map[string]any{"meetingId": id, "approver": "required"})
	if got := required(); !slices.Equal(got, []string{"codex:a", "codex:f"}) || version() != 3 {
		t.Fatalf("after required %v v%d", got, version())
	}
	// a leaves, then f leaves: an empty list reads "none".
	h.as("a", "leave_meeting", map[string]any{"meetingId": id})
	h.as("f", "leave_meeting", map[string]any{"meetingId": id})
	if _, _, text := h.lastMessage(id); text != fmt.Sprintf(texts.ApproversChanged, 1, 5, "none") {
		t.Fatalf("empty list %q", text)
	}
	want := []string{}
	for i := 2; i <= 5; i++ {
		want = append(want, fmt.Sprintf("updated %s %d", id, i))
	}
	if !slices.Equal(n.calls, want) {
		t.Fatalf("notifier %v, want %v", n.calls, want)
	}
	if m := h.listing(id); m.Status != "active" {
		t.Fatalf("status %s", m.Status)
	}
}

func TestConsensusSummarySaysHowItEnded(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	h.stanceAs("a", id, 1, "endorse", "")
	h.stanceAs("b", id, 1, "endorse", "")
	for _, m := range h.ok("list_meetings", map[string]any{}, "")["meetings"].([]any) {
		if m := m.(map[string]any); m["id"] == id {
			if s, _ := m["summary"].(string); !strings.Contains(s, "by consensus on draft #1") {
				t.Fatalf("summary %q", s)
			}
		}
	}
}

func TestReopenedMeetingNeedsANewDraft(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("c", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	for _, s := range []string{"a", "b", "c"} {
		h.stanceAs(s, id, 1, "endorse", "")
	}
	h.as("a", "reopen_meeting", map[string]any{"meetingId": id})
	h.as("c", "leave_meeting", map[string]any{"meetingId": id})
	if n := h.count(`SELECT COUNT(*) FROM decisions WHERE meeting_id = ?`, id); n != 1 {
		t.Fatalf("%d decisions after reopening", n)
	}
	for _, m := range h.ok("list_meetings", map[string]any{}, "")["meetings"].([]any) {
		if m := m.(map[string]any); m["id"] == id && (m["status"] != "active" || m["proposal"] != nil) {
			t.Fatalf("reopened %v %v", m["status"], m["proposal"])
		}
	}
}

func TestRejoinedMemberStaysOffTheList(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("d", "join_meeting", map[string]any{"meetingId": id})
	h.as("d", "leave_meeting", map[string]any{"meetingId": id})
	h.clock.Set(start.Add(time.Second))
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	h.clock.Set(start.Add(2 * time.Second))
	h.as("d", "join_meeting", map[string]any{"meetingId": id})
	h.as("d", "join_meeting", map[string]any{"meetingId": id, "mode": "async", "approver": "required"})
	if n := h.count(`SELECT COUNT(*) FROM meeting_approvers WHERE meeting_id = ? AND member_id = 'codex:d'`, id); n != 0 {
		t.Fatal("rejoined member put on the list")
	}
}

func TestSessionLikeInstanceIDsDoNotApprove(t *testing.T) {
	for _, instance := range []string{"codex:buildbot", "claude:buildbot"} {
		t.Run(instance, func(t *testing.T) {
			h := newHarnessWith(t, fakeIdentities{})
			id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
			joined := h.ok("join_meeting", map[string]any{"meetingId": id}, instance)
			if joined["identity"] != "instance" || joined["delivery"] != "unavailable" {
				t.Fatalf("instance identity %v", joined)
			}
			h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
			h.ok("join_meeting", map[string]any{"meetingId": id, "approver": "optional"}, instance)
			h.ok("join_meeting", map[string]any{"meetingId": id, "approver": "required"}, instance)
			if got := h.listing(id).Proposal.Required; !slices.Equal(got, []string{"codex:a"}) {
				t.Fatalf("instance added to approvers %v", got)
			}
			h.stanceAs("a", id, 1, "endorse", "")
			h.catchUp(id, instance)
			res := h.ok("stance", map[string]any{"meetingId": id, "messageId": 1, "stance": "endorse"}, instance)
			if res["counted"] != false || res["decided"] != false || h.listing(id).Status != "active" {
				t.Fatalf("instance endorsement decided %v", res)
			}
		})
	}
}

func TestInstanceCannotEndorseAsSameNamedSession(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	h.stanceAs("a", id, 1, "endorse", "")
	h.catchUp(id, "codex:b")
	res := h.ok("stance", map[string]any{"meetingId": id, "messageId": 1, "stance": "endorse"}, "codex:b")
	if res["counted"] != false || res["decided"] != false {
		t.Fatalf("same-named instance counted %v", res)
	}
	// Only the resolved session's own endorsement can satisfy its required vote.
	if res := h.stanceAs("b", id, 1, "endorse", ""); res["decided"] != true {
		t.Fatalf("session endorsement not counted %v", res)
	}
}

func TestDraftEligibilityUsesMembershipSnapshot(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "t"})["meetingId"].(string)
	h.as("before", "join_meeting", map[string]any{"meetingId": id, "approver": "optional"})
	h.as("rejoined", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "p", "draft": true})
	// All calls have the same persisted millisecond. A later join and a rejoin
	// cannot gain eligibility by repeating join or toggling approver.
	h.as("late", "join_meeting", map[string]any{"meetingId": id})
	h.as("rejoined", "leave_meeting", map[string]any{"meetingId": id})
	h.as("rejoined", "join_meeting", map[string]any{"meetingId": id})
	for _, session := range []string{"late", "rejoined"} {
		h.as(session, "join_meeting", map[string]any{"meetingId": id})
		h.as(session, "join_meeting", map[string]any{"meetingId": id, "approver": "optional"})
		h.as(session, "join_meeting", map[string]any{"meetingId": id, "approver": "required"})
	}
	// A genuinely earlier optional member from that same millisecond may opt in.
	h.as("before", "join_meeting", map[string]any{"meetingId": id, "approver": "required"})
	if got := h.listing(id).Proposal.Required; !slices.Equal(got, []string{"codex:a", "codex:before"}) {
		t.Fatalf("draft eligibility %v", got)
	}
	// A new draft takes a new snapshot, including the late and rejoined members.
	h.catchUpAs("a", id)
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "next", "draft": true})
	if got := h.listing(id).Proposal.Required; !slices.Equal(got, []string{"codex:a", "codex:before", "codex:rejoined", "codex:late"}) {
		t.Fatalf("next draft eligibility %v", got)
	}
}
