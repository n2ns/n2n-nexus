package agents

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// meeting creates an active meeting with members (id → mode), as the core tools would.
func (h *harness) meeting(id string, members map[string]string) {
	h.t.Helper()
	h.exec(`INSERT INTO meetings (id, topic, status, is_default, active_order, initiator, participants, created_at)
		VALUES (?, ?, 'active', 0, 1, 'x', '[]', 'x')`, id, "Topic "+id)
	for member, mode := range members {
		kind := "instance"
		if strings.HasPrefix(member, "codex:") || strings.HasPrefix(member, "claude:") {
			kind = "session"
		}
		h.exec(`INSERT INTO meeting_members (meeting_id, member_id, identity_kind, mode, approver, joined_at) VALUES (?, ?, ?, ?, 'required', 'x')`, id, member, kind, mode)
	}
}

// postInMeeting adds a meeting message and tells the agents, as send_message does.
func (h *harness) postInMeeting(meetingID, sender, text string) {
	h.t.Helper()
	seq := h.count(`SELECT COALESCE(MAX(seq), 0) + 1 FROM meeting_messages WHERE meeting_id = ?`, meetingID)
	h.exec(`INSERT INTO meeting_messages (meeting_id, seq, sender, text, timestamp, sender_name) VALUES (?, ?, ?, ?, 'x', (SELECT name FROM agent_sessions WHERE id = ?))`, meetingID, seq, sender, text, sender)
	h.ag.MeetingUpdated(meetingID)
}

func (h *harness) exec(query string, args ...any) {
	h.t.Helper()
	if _, err := h.ag.db().Exec(query, args...); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) wakes(meetingID, member string) int {
	return h.count(`SELECT wakes FROM meeting_members WHERE meeting_id = ? AND member_id = ?`, meetingID, member)
}

func TestMeetingNewsWakesActiveMembers(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	for _, s := range []string{"a", "b", "c"} {
		h.hook("codex", "SessionStart", s)
		h.hook("codex", "Stop", s, stopActive)
	}
	h.meeting("m1", map[string]string{"codex:a": "active", "codex:b": "active", "codex:c": "async", "mcp-plain": "active"})

	waitA := h.openHook("codex", texts0BackgroundWait(), "a")
	h.untilStatus("codex:a", "listening")
	waitB := h.openHook("codex", texts0BackgroundWait(), "b")
	h.untilStatus("codex:b", "listening")
	waitC := h.openHook("codex", texts0BackgroundWait(), "c")
	h.untilStatus("codex:c", "listening")

	// a's own message wakes b, not a; the async member c is not woken.
	h.postInMeeting("m1", "codex:a", "first")
	wake := waitB.wait(t).str("wake")
	contains(t, wake, fmt.Sprintf(texts.MeetingNews, "Topic m1", "m1", 1, 1, 1)+"\n"+
		fmt.Sprintf(texts.MeetingMessageHeader, 1, h.session("codex:a").Name, "x", "")+"\nfirst\n"+fmt.Sprintf(texts.MeetingMessageEnd, 1))
	contains(t, wake, texts.MeetingClosing)
	notContains(t, wake, texts.MeetingReadRest)
	// Shown whole by a wake, it is read.
	eq(t, h.cursor("codex:b", "m1"), h.row("m1", 1))
	notContains(t, wake, "Automatic turn")
	eq(t, h.wakes("m1", "codex:b"), 1)
	turns, _, _ := h.agentState("codex:b")
	eq(t, turns, 0) // meeting news is no automatic turn

	// Two more while b works on the first: b's news is merged into one line at its next hook.
	h.postInMeeting("m1", "codex:c", "second")
	h.postInMeeting("m1", "codex:c", "third")
	// a's wait was woken by the first of them at once.
	contains(t, waitA.wait(t).str("wake"), fmt.Sprintf(texts.MeetingNews, "Topic m1", "m1", 1, 2, 2))
	ctx := h.hook("codex", "PostToolUse", "b").context()
	contains(t, ctx, fmt.Sprintf(texts.MeetingNews, "Topic m1", "m1", 2, 2, 3))
	contains(t, ctx, "\nsecond\n")
	contains(t, ctx, "\nthird\n")
	// A tool call's context may reach a sub-agent only: still unread.
	eq(t, h.cursor("codex:b", "m1"), h.row("m1", 1))
	if out := h.hook("codex", "PostToolUse", "b"); out != nil {
		t.Fatalf("news repeated %v", out)
	}
	eq(t, h.wakes("m1", "codex:b"), 1) // a tool call's context is no wake

	// c (async) was never woken; its next prompt has the news from a.
	eq(t, h.status("codex:c"), "listening")
	contains(t, h.hook("codex", "UserPromptSubmit", "c").context(), "\nfirst\n")
	if out := waitC.wait(t); out != nil {
		t.Fatalf("async member woken: %v", out)
	}
	// A prompt's context reaches the conversation: read.
	eq(t, h.cursor("codex:c", "m1"), h.row("m1", 1))
}

// cursor is a reader's read cursor in a meeting, 0 when it has none.
func (h *harness) cursor(reader, meetingID string) int {
	return h.count(`SELECT COALESCE(MAX(last_read_id), 0) FROM read_cursors WHERE instance_id = ? AND context_type = 'meeting' AND context_id = ?`, reader, meetingID)
}

// row is the table id of a meeting's message seq.
func (h *harness) row(meetingID string, seq int) int {
	return h.count(`SELECT id FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, seq)
}

func TestMeetingNewsHoldsStopOfActiveMembersOnly(t *testing.T) {
	h := start(t)
	for _, s := range []string{"a", "b", "c"} {
		h.hook("codex", "SessionStart", s)
	}
	h.meeting("m1", map[string]string{"codex:b": "active", "codex:c": "async"})
	h.postInMeeting("m1", "codex:a", "hello")
	blocked := h.hook("codex", "Stop", "b", stopInactive)
	eq(t, blocked.str("decision"), "block")
	contains(t, blocked.str("reason"), "Topic m1")
	notContains(t, blocked.str("reason"), texts.MessageTrustNote)
	if out := h.hook("codex", "Stop", "c", stopInactive); out != nil {
		t.Fatalf("async Stop held: %v", out)
	}
	contains(t, h.hook("codex", "UserPromptSubmit", "c").context(), "Topic m1")
}

func TestMeetingNewsStopsWithLeaveAndEnd(t *testing.T) {
	h := start(t)
	for _, s := range []string{"a", "b"} {
		h.hook("codex", "SessionStart", s)
	}
	h.meeting("m1", map[string]string{"codex:b": "active"})
	h.postInMeeting("m1", "codex:a", "before leaving")
	h.exec(`UPDATE meeting_members SET left_at = 'x' WHERE member_id = 'codex:b'`)
	if out := h.hook("codex", "Stop", "b", stopInactive); out != nil {
		t.Fatalf("left member held: %v", out)
	}
	h.exec(`UPDATE meeting_members SET left_at = NULL WHERE member_id = 'codex:b'`)
	h.exec(`UPDATE meetings SET status = 'closed', summary = 'agreed' WHERE id = 'm1'`)
	h.ag.MeetingClosed("m1", "")
	blocked := h.hook("codex", "Stop", "b", stopInactive)
	reason := blocked.str("reason")
	contains(t, reason, fmt.Sprintf(texts.MeetingEnded, "Topic m1", "m1", ": agreed"))
	notContains(t, reason, "before leaving")
	notContains(t, reason, texts.MeetingClosing)
	turns, _, _ := h.agentState("codex:b")
	eq(t, turns, 0) // a meeting notice is no automatic turn
}

func TestMeetingNewsPastTheAutoTurnLimit(t *testing.T) {
	h := start(t, listenWait(5*time.Second), maxTurns(1))
	for _, s := range []string{"a", "b"} {
		h.hook("codex", "SessionStart", s)
	}
	h.hook("codex", "Stop", "b", stopActive)
	h.meeting("m1", map[string]string{"codex:b": "active"})
	// One automatic turn uses the limit up.
	waiting := h.openHook("codex", texts0BackgroundWait(), "b")
	h.untilStatus("codex:b", "listening")
	h.send("a", "codex:b", "dm 1", false)
	contains(t, waiting.wait(t).str("wake"), "dm 1")
	h.hook("codex", "Stop", "b", stopActive)

	// Past the limit, a direct message waits, but meeting news still wakes, without the direct message.
	waiting = h.openHook("codex", texts0BackgroundWait(), "b")
	h.untilStatus("codex:b", "listening")
	h.send("a", "codex:b", "dm 2", false)
	h.postInMeeting("m1", "codex:a", "news")
	wake := waiting.wait(t).str("wake")
	contains(t, wake, "Topic m1")
	notContains(t, wake, "dm 2")
	eq(t, h.count(`SELECT COUNT(*) FROM agent_messages WHERE text = 'dm 2' AND notified_at IS NULL`), 1)
}

func TestWakeResultFailedRestoresMeetingNews(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	for _, s := range []string{"a", "b"} {
		h.hook("codex", "SessionStart", s)
	}
	h.hook("codex", "Stop", "b", stopActive)
	h.meeting("m1", map[string]string{"codex:b": "active"})
	waiting := h.openHook("codex", texts0BackgroundWait(), "b")
	h.untilStatus("codex:b", "listening")
	h.postInMeeting("m1", "codex:a", "news")
	out := waiting.wait(t)
	eq(t, h.wakes("m1", "codex:b"), 1)
	notified := h.count(`SELECT notified_id FROM meeting_members WHERE member_id = 'codex:b'`)
	if notified == 0 {
		t.Fatal("watermark not moved")
	}
	eq(t, h.cursor("codex:b", "m1"), h.row("m1", 1))
	h.hook("codex", h.ag.o.Contract.Hook.WakeResultEvent, "b", wakeResult(out.str("dispatchId"), false))
	eq(t, h.wakes("m1", "codex:b"), 0)
	eq(t, h.count(`SELECT notified_id FROM meeting_members WHERE member_id = 'codex:b'`), 0)
	eq(t, h.cursor("codex:b", "m1"), 0)
	again := h.openHook("codex", texts0BackgroundWait(), "b").wait(t)
	contains(t, again.str("wake"), "Topic m1")
}

func TestDirectMessageKinds(t *testing.T) {
	h := start(t, listenWait(2*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	// wake false: the wait is not woken and the Stop is not held.
	waiting := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	sent := h.codex("s", "send", map[string]any{"to": "codex:r", "text": "fyi done", "expectsReply": false, "wake": false})
	eq(t, sent.status, 200)
	if out := waiting.wait(t); out["timeout"] != true {
		t.Fatalf("woken by a wake=false message: %v", out)
	}
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("Stop held by a wake=false message: %v", out)
	}
	// It is announced at the next prompt, marked, without asking for a reply.
	ctx := h.hook("codex", "UserPromptSubmit", "r").context()
	contains(t, ctx, "fyi done\n--- End of message ")
	contains(t, ctx, " ---\n"+texts.NoReplyMark+"\n")
	contains(t, ctx, texts.MessageInfoNote)
	notContains(t, ctx, texts.MessageTrustNote)
	// Shown whole and needing no reply, it is read: read has nothing left.
	eq(t, len(h.codex("r", "read", nil).result["messages"].([]any)), 0)
}

func TestMeetingEndNoticeSparesTheCloserAndAsyncMembers(t *testing.T) {
	h := start(t)
	for _, s := range []string{"a", "b", "c"} {
		h.hook("codex", "SessionStart", s)
	}
	h.meeting("m1", map[string]string{"codex:a": "active", "codex:b": "active", "codex:c": "async"})
	h.exec(`UPDATE meetings SET status = 'closed' WHERE id = 'm1'`)
	h.ag.MeetingClosed("m1", "codex:a")
	// The member that ended it is not told; an async member is told at its next prompt, not by holding its Stop.
	if out := h.hook("codex", "Stop", "a", stopInactive); out != nil {
		t.Fatalf("closer held: %v", out)
	}
	if out := h.hook("codex", "Stop", "c", stopInactive); out != nil {
		t.Fatalf("async member held: %v", out)
	}
	contains(t, h.hook("codex", "UserPromptSubmit", "c").context(), "has ended")
	eq(t, h.hook("codex", "Stop", "b", stopInactive).str("decision"), "block")
}

func TestMeetingNoticeWakesActiveMembersOnly(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	for _, s := range []string{"a", "c"} {
		h.hook("codex", "SessionStart", s)
		h.hook("codex", "Stop", s, stopActive)
	}
	h.meeting("m1", map[string]string{"codex:a": "active", "codex:c": "async"})
	waitA := h.openHook("codex", texts0BackgroundWait(), "a")
	h.untilStatus("codex:a", "listening")
	waitC := h.openHook("codex", texts0BackgroundWait(), "c")
	h.untilStatus("codex:c", "listening")

	h.ag.MeetingNotice("m1", []string{"codex:a", "codex:c", "codex:ghost"}, "Take a stance on draft #1.")
	contains(t, waitA.wait(t).str("wake"), "Take a stance on draft #1.")
	// The async member is not woken; it sees the notice at its next hook. A session that does not exist is skipped.
	eq(t, h.status("codex:c"), "listening")
	contains(t, h.hook("codex", "UserPromptSubmit", "c").context(), "Take a stance on draft #1.")
	if out := waitC.wait(t); out != nil {
		t.Fatalf("async member woken: %v", out)
	}
	eq(t, h.count(`SELECT COUNT(*) FROM agent_notices WHERE session_id = 'codex:ghost'`), 0)
	eq(t, h.count(`SELECT COUNT(*) FROM agent_notices WHERE meeting_id = 'm1'`), 2)
}

// A notification shows meeting texts up to notifyTextChars in all; what it
// shows whole is read only when nothing of others before it is left unread.
func TestMeetingNewsTextsAndReadCursor(t *testing.T) {
	h := start(t)
	limit := testContract.Hook.Limits.NotifyTextChars
	for _, s := range []string{"a", "b"} {
		h.hook("codex", "SessionStart", s)
	}
	h.meeting("m1", map[string]string{"codex:b": "active"})
	h.meeting("m2", map[string]string{"codex:b": "active"})
	h.postInMeeting("m1", "codex:a", "short")
	h.postInMeeting("m1", "codex:a", strings.Repeat("x", limit))
	h.postInMeeting("m1", "codex:a", "after")
	h.postInMeeting("m2", "codex:a", "other meeting")
	h.exec(`UPDATE meeting_messages SET category = 'PROPOSAL' WHERE meeting_id = 'm1' AND seq = 1`)
	reason := h.hook("codex", "Stop", "b", stopInactive)["reason"].(string)
	contains(t, reason, fmt.Sprintf(texts.MeetingMessageHeader, 1, h.session("codex:a").Name, "x", " (PROPOSAL)")+"\nshort\n")
	contains(t, reason, strings.Repeat("x", limit-5)+"\n"+fmt.Sprintf(texts.MessageCut, limit-5, limit))
	contains(t, reason, fmt.Sprintf(texts.MeetingNotShown, 1, 3, 3))
	contains(t, reason, fmt.Sprintf(texts.MeetingNews, "Topic m2", "m2", 1, 1, 1)+"\n"+fmt.Sprintf(texts.MeetingNotShown, 1, 1, 1))
	contains(t, reason, texts.MeetingReadRest)
	notContains(t, reason, "after")
	eq(t, h.cursor("codex:b", "m1"), h.row("m1", 1))
	eq(t, h.cursor("codex:b", "m2"), 0)

	// Shown by a tool call only, #4 stays unread; a Stop that then shows #5
	// leaves it unread too, since #4 before it is.
	h.postInMeeting("m1", "codex:a", "four")
	contains(t, h.hook("codex", "PostToolUse", "b").context(), "\nfour\n")
	h.postInMeeting("m1", "codex:a", "five")
	contains(t, h.hook("codex", "Stop", "b", stopInactive)["reason"].(string), "\nfive\n")
	eq(t, h.cursor("codex:b", "m1"), h.row("m1", 1))
}
