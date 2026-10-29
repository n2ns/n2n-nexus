package core

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func unreadIDs(res map[string]any) string {
	var out []string
	for _, m := range res["unread"].([]any) {
		m := m.(map[string]any)
		id := fmt.Sprint(m["id"])
		if m["cut"] == true {
			id += " cut"
		}
		out = append(out, id)
	}
	return strings.Join(out, ",")
}

func decode(t *testing.T, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) readCursor(reader, meetingID string) int {
	return h.count(`SELECT COALESCE(MAX(last_read_id), 0) FROM read_cursors WHERE instance_id = ? AND context_type = 'meeting' AND context_id = ?`, reader, meetingID)
}

func (h *harness) seqRow(meetingID string, seq int) int {
	return h.count(`SELECT id FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, seq)
}

func TestSendNeedsWhatOthersSaidReadFirst(t *testing.T) {
	h, n := newNotedHarness(t)
	id := h.as("a", "start_meeting", map[string]any{"topic": "Plan"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	send := func(text string) map[string]any { return map[string]any{"meetingId": id, "message": text} }
	h.as("a", "send_message", send("one")) // #1
	h.as("a", "send_message", send("two")) // #2: own messages are never unread

	// A history read does not count; a refused message is not posted and tells nobody.
	h.as("b", "read_messages", map[string]any{"meetingId": id, "latest": true})
	n.calls = nil
	res := h.refusedAs("b", "send_message", send("my point"))
	if unreadIDs(res) != "1,2" || res["sentTo"] != "meeting" || res["messageId"] != nil || !strings.Contains(res["message"].(string), "(#1–#2)") {
		t.Fatalf("refused %v", res)
	}
	if h.count(`SELECT COUNT(*) FROM meeting_messages WHERE text = 'my point'`) != 0 || len(n.calls) != 0 {
		t.Fatal("a refused message was posted")
	}
	// What was attached is read and announced.
	if h.readCursor("codex:b", id) != h.seqRow(id, 2) || h.count(`SELECT notified_id FROM meeting_members WHERE member_id = 'codex:b'`) != h.seqRow(id, 2) {
		t.Fatal("attached messages not marked")
	}
	h.as("b", "send_message", send("my point")) // #3

	// a has not read #3: refused. b posts #4 meanwhile; a's next send goes
	// through all the same, noting #4, which stays unread.
	if res := h.refusedAs("a", "send_message", send("three")); unreadIDs(res) != "3" {
		t.Fatalf("a refused %v", res)
	}
	h.as("b", "send_message", send("four")) // #4
	res = h.as("a", "send_message", send("three"))
	_, _, text := h.lastMessage(id)
	if res["messageId"] != 5.0 || text != "three\n\n"+fmt.Sprintf(h.core.d.Contract.Hook.Texts.SentWithUnread, "#4") {
		t.Fatalf("passed %v %q", res, text)
	}
	if h.readCursor("codex:a", id) != h.seqRow(id, 3) {
		t.Fatal("the noted messages were marked read")
	}
	// Only the one send after a refusal goes through.
	if res := h.refusedAs("a", "send_message", send("again")); unreadIDs(res) != "4" {
		t.Fatalf("again %v", res)
	}
}

func TestRefusalCutsAttachedTexts(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	limit := h.core.d.Contract.Hook.Limits.NotifyTextChars
	id := h.as("a", "start_meeting", map[string]any{"topic": "Long"})["meetingId"].(string)
	for _, text := range []string{strings.Repeat("x", limit-10), strings.Repeat("y", 20), "short"} {
		h.as("a", "send_message", map[string]any{"meetingId": id, "message": text})
	}
	r := h.call("send_message", map[string]any{"meetingId": id, "message": "mine"}, "mcp-c")
	res := map[string]any{}
	decode(t, r.result, &res)
	if res["refused"] != true || unreadIDs(res) != "1,2 cut" || !strings.Contains(res["message"].(string), "read_messages(meetingId: "+id+")") {
		t.Fatalf("refused %v", res)
	}
	if got := res["unread"].([]any)[1].(map[string]any)["text"]; got != strings.Repeat("y", 10) {
		t.Fatalf("cut text %q", got)
	}
	if h.readCursor("mcp-c", id) != h.seqRow(id, 1) {
		t.Fatal("cursor not at the last message attached whole")
	}
	res = h.ok("send_message", map[string]any{"meetingId": id, "message": "mine"}, "mcp-c")
	if _, _, text := h.lastMessage(id); !strings.HasSuffix(text, fmt.Sprintf(h.core.d.Contract.Hook.Texts.SentWithUnread, "#2–#3")) {
		t.Fatalf("note %q", text)
	}

	// One message past the limit alone: attached cut, nothing read.
	other := h.as("a", "start_meeting", map[string]any{"topic": "Longer"})["meetingId"].(string)
	h.as("a", "send_message", map[string]any{"meetingId": other, "message": strings.Repeat("z", limit+1)})
	if res := h.refusedAs("b", "send_message", map[string]any{"meetingId": other, "message": "mine"}); unreadIDs(res) != "1 cut" {
		t.Fatalf("refused %v", res)
	}
	if h.readCursor("codex:b", other) != 0 {
		t.Fatal("a cut message was marked read")
	}
}

func TestStanceNeedsWhatOthersSaidReadFirst(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "Plan"})["meetingId"].(string)
	h.as("b", "join_meeting", map[string]any{"meetingId": id})
	h.as("c", "join_meeting", map[string]any{"meetingId": id})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "plan", "draft": true}) // #1
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "details"})             // #2
	stance := func(s string) map[string]any {
		args := map[string]any{"meetingId": id, "messageId": 1, "stance": s}
		if s == "object" {
			args["note"] = "no, see #1"
		}
		return args
	}
	if res := h.refusedAs("b", "stance", stance("endorse")); unreadIDs(res) != "1,2" || !strings.Contains(res["message"].(string), "Stance not taken") {
		t.Fatalf("refused %v", res)
	}
	if h.count(`SELECT COUNT(*) FROM meeting_stances`) != 0 {
		t.Fatal("a refused stance was taken")
	}
	h.as("b", "stance", stance("endorse"))

	// A withdrawal goes through, with what is unread.
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "more"}) // #3
	res := h.as("b", "stance", stance("withdraw"))
	if res["ok"] != true || unreadIDs(res) != "3" || !strings.HasPrefix(res["message"].(string), "Stance withdrawn.") {
		t.Fatalf("withdraw %v", res)
	}
	// A refused send lets the next send through, not a stance.
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "four"}) // #4
	h.refusedAs("b", "send_message", map[string]any{"meetingId": id, "message": "x"})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "five"}) // #5
	if res := h.refusedAs("b", "stance", stance("object")); unreadIDs(res) != "5" {
		t.Fatalf("stance after a refused send %v", res)
	}
	// An instance is held to the same rule.
	h.ok("join_meeting", map[string]any{"meetingId": id}, "mcp-x")
	h.catchUpAs("c", id)
	h.as("c", "send_message", map[string]any{"meetingId": id, "message": "c here"}) // #6; mcp-x's cursor starts at its join
	r := h.call("stance", stance("object"), "mcp-x")
	res = map[string]any{}
	decode(t, r.result, &res)
	if res["refused"] != true || unreadIDs(res) != "6" {
		t.Fatalf("instance %v", res)
	}
}

// When the texts attached whole use up the limit, nothing more is attached.
func TestRefusalStopsAtTheLimit(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	limit := h.core.d.Contract.Hook.Limits.NotifyTextChars
	id := h.as("a", "start_meeting", map[string]any{"topic": "Exact"})["meetingId"].(string)
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": strings.Repeat("x", limit)})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "next"})
	res := h.refusedAs("b", "send_message", map[string]any{"meetingId": id, "message": "mine"})
	if unreadIDs(res) != "1" || !strings.Contains(res["message"].(string), "read_messages(meetingId: "+id+")") {
		t.Fatalf("refused %v", res)
	}
}

// A draft or a DECISION becomes a decision's text: it is never let through unread.
func TestDraftAndDecisionNeedEverythingRead(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "Drafts"})["meetingId"].(string)
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "one"})
	h.refusedAs("b", "send_message", map[string]any{"meetingId": id, "message": "x"})
	h.as("a", "send_message", map[string]any{"meetingId": id, "message": "two"})
	for _, args := range []map[string]any{
		{"meetingId": id, "message": "plan", "draft": true},
		{"meetingId": id, "message": "decided", "category": "DECISION"},
	} {
		if res := h.refusedAs("b", "send_message", args); !strings.Contains(res["message"].(string), "only once everything is read") {
			t.Fatalf("refused %v", res)
		}
		h.as("a", "send_message", map[string]any{"meetingId": id, "message": "more"})
	}
	// A plain message still goes through after a refusal, noted.
	h.as("b", "send_message", map[string]any{"meetingId": id, "message": "plain"})
	if _, _, text := h.lastMessage(id); !strings.HasPrefix(text, "plain\n\n[n2n-nexus: sent while") {
		t.Fatalf("plain %q", text)
	}
	if h.count(`SELECT COUNT(*) FROM decisions`) != 0 || h.count(`SELECT COUNT(*) FROM meeting_messages WHERE category = 'PROPOSAL'`) != 0 {
		t.Fatal("a refused draft or decision was posted")
	}
}
