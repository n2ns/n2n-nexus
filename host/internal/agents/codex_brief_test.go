package agents

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func briefWake(news string) string { return prefix + " " + fmt.Sprintf(texts.BriefWake, news) }
func briefHold(news string) string { return prefix + " " + fmt.Sprintf(texts.BriefHold, news) }

// codexWake starts codex:s and codex:r (idle) and returns the wake a background
// wait of r gets for a message from s.
func codexWake(t *testing.T, h *harness, text string) hookOutput {
	t.Helper()
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	waiting := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", text, false)
	return waiting.wait(t)
}

func (h *harness) messageCount(where string) int {
	return h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND " + where)
}

// Codex shows the prompt of codex queue in its chat: the wake says only what is
// new, and the context of the prompt it becomes, which Codex does not show, has the text.
func TestCodexWakeIsBriefAndItsPromptBringsTheText(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	out := codexWake(t, h, "secret line\nsecond line")
	eq(t, out.str("wake"), briefWake(fmt.Sprintf(texts.BriefMessages, 1, h.session("codex:s").Name)))
	eq(t, h.status("codex:r"), "working")
	eq(t, h.messageCount("notified_at IS NULL AND status = 'unread'"), 1) // the wake marks nothing
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), true))

	ctx := h.hook("codex", "UserPromptSubmit", "r").context()
	contains(t, ctx, prefix+" 1 new direct message:")
	contains(t, ctx, "secret line\nsecond line\n")
	contains(t, ctx, texts.MessageTrustNote+" "+texts.NotifyClosing)
	eq(t, h.messageCount("status = 'read'"), 1)
	// Delivered once.
	if out := h.hook("codex", "PostToolUse", "r"); out != nil {
		t.Fatalf("repeated: %v", out)
	}
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("held: %v", out)
	}
}

// What the prompt's hook did not bring (it failed, or the host was away) is not lost.
func TestCodexWakeWithoutItsPromptHookLeavesTheMessageUnread(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	codexWake(t, h, "ping")
	read := h.codex("r", "read", nil).result["messages"].([]any)
	eq(t, len(read), 1)
	eq(t, read[0].(map[string]any)["text"], any("ping"))
}

// A wake whose prompt never came: the user's next prompt, even much later, has the text.
func TestCodexWakeWhosePromptNeverCame(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	out := codexWake(t, h, "ping")
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), true))
	h.at(ms(timing.WakePromptWindowMs) + time.Second)
	contains(t, h.hook("codex", "UserPromptSubmit", "r").context(), "ping")
}

func TestCodexFailedWakeIsDeliveredAgain(t *testing.T) {
	h := start(t, listenWait(5*time.Second), maxTurns(2))
	out := codexWake(t, h, "ping")
	contains(t, out.str("wake"), "Automatic turn 1 of 2")
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), false))
	eq(t, h.status("codex:r"), "idle")
	again := h.openHook("codex", texts0BackgroundWait(), "r").wait(t)
	eq(t, again.str("wake"), out.str("wake")) // again the first automatic turn
	contains(t, h.wokenText("r", again), "ping")
}

func TestCodexWakeNamesSendersMeetingsAndNotices(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	for _, id := range []string{"s", "a", "r"} {
		h.hook("codex", "SessionStart", id)
	}
	h.meeting("m1", map[string]string{"codex:r": "active"})
	h.exec(`INSERT INTO agent_notices (session_id, text, created_at) VALUES ('codex:r', 'a notice for r', '2026-01-01T00:00:00.000Z')`)
	h.send("s", "codex:r", "one", false)
	h.send("s", "codex:r", "two", false)
	h.send("a", "codex:r", "three", false)
	h.postInMeeting("m1", "codex:a", "meeting text")
	h.hook("codex", "Stop", "r", stopActive)
	out := h.openHook("codex", texts0BackgroundWait(), "r").wait(t)
	eq(t, out.str("wake"), briefWake(fmt.Sprintf(texts.BriefMessages, 3, h.session("codex:s").Name+", "+h.session("codex:a").Name)+"; "+
		fmt.Sprintf(texts.BriefMeeting, 1, "Topic m1", "m1")+"; "+fmt.Sprintf(texts.BriefNotices, 1)))
	eq(t, h.wakes("m1", "codex:r"), 1)
	eq(t, h.cursor("codex:r", "m1"), 0)
	ctx := h.wokenText("r", out)
	for _, text := range []string{"one", "two", "three", "meeting text", "a notice for r"} {
		contains(t, ctx, text)
	}
	eq(t, h.cursor("codex:r", "m1"), h.row("m1", 1))
	eq(t, h.wakes("m1", "codex:r"), 1) // the prompt is no second wake
}

// Codex shows a Stop's reason too: it says what is new, read returns the text.
func TestCodexHeldStopIsBrief(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.meeting("m1", map[string]string{"codex:r": "active"})
	h.exec(`INSERT INTO agent_notices (session_id, text, created_at) VALUES ('codex:r', 'a notice for r', '2026-01-01T00:00:00.000Z')`)
	h.send("s", "codex:r", "secret", false)
	h.postInMeeting("m1", "codex:s", "meeting text")
	out := h.hook("codex", "Stop", "r", stopInactive)
	eq(t, out.str("decision"), "block")
	eq(t, out.str("reason"), briefHold(fmt.Sprintf(texts.BriefMessages, 1, h.session("codex:s").Name)+"; "+fmt.Sprintf(texts.BriefMeeting, 1, "Topic m1", "m1"))+
		"\n"+prefix+" Notices:\n- a notice for r") // no tool returns a notice
	eq(t, h.messageCount("status = 'unread' AND notified_at IS NOT NULL"), 1)
	eq(t, h.cursor("codex:r", "m1"), 0)

	if out := h.hook("codex", "PostToolUse", "r"); out != nil {
		t.Fatalf("repeated: %v", out)
	}
	read := h.codex("r", "read", nil).result["messages"].([]any)
	eq(t, read[0].(map[string]any)["text"], any("secret"))
	h.exec(`INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES ('codex:r', 'meeting', 'm1', ?, 'x')`, h.row("m1", 1))
	// Read: nothing is offered again when the continued turn ends.
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatalf("held: %v", out)
	}
	if out := h.openHook("codex", texts0BackgroundWait(), "r").wait(t); out["timeout"] != true {
		t.Fatalf("offered again: %v", out)
	}
}

// A model that did not call read after a brief Stop: the background wait offers
// the messages again, once, with the text in the woken prompt.
func TestCodexHeldStopNotReadIsOfferedAgain(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.meeting("m1", map[string]string{"codex:r": "active"})
	h.send("s", "codex:r", "ignored message", false)
	h.postInMeeting("m1", "codex:s", "ignored news")
	eq(t, h.hook("codex", "Stop", "r", stopInactive).str("decision"), "block")
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	ctx := h.wokenText("r", h.openHook("codex", texts0BackgroundWait(), "r").wait(t))
	contains(t, ctx, "ignored message")
	contains(t, ctx, "ignored news")
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("offered a third time: %v", out)
	}
}

// A listening Stop is brief too, and a model that never reads is not held again and again.
func TestCodexListeningStopIsBrief(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	waiting := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "secret", false)
	out := waiting.wait(t)
	eq(t, out.str("decision"), "block")
	eq(t, out.str("reason"), briefHold(fmt.Sprintf(texts.BriefMessages, 1, h.session("codex:s").Name)))
	eq(t, h.messageCount("status = 'unread'"), 1)
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatalf("held again: %v", out)
	}
	// Still unread: the user's next prompt says so.
	contains(t, h.hook("codex", "UserPromptSubmit", "r").context(), fmt.Sprintf(texts.EarlierUnread, 1))
}

func TestCodexHeldAndIgnoredWhileListeningEnds(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.hook("codex", "UserPromptSubmit", "r")
	h.send("s", "codex:r", "ignored", false)
	eq(t, h.hook("codex", "Stop", "r", stopInactive).str("decision"), "block")
	eq(t, h.hook("codex", "Stop", "r", stopActive).str("decision"), "block") // offered again once
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatalf("held a third time: %v", out)
	}
}

func TestCodexBriefNamesAtMostTheListLimit(t *testing.T) {
	h := start(t)
	h.hook("codex", "UserPromptSubmit", "r")
	n := testContract.Hook.Limits.NotifyListLimit + 2
	for i := range n {
		id := fmt.Sprintf("s%d", i)
		h.hook("codex", "SessionStart", id)
		h.send(id, "codex:r", "x", false)
	}
	reason := h.hook("codex", "Stop", "r", stopInactive).str("reason")
	contains(t, reason, fmt.Sprintf("%d message(s) from ", n))
	contains(t, reason, ", 2 more.")
	eq(t, strings.Count(reason, "\n"), 0)
}

// The other clients keep whole texts.
func TestOtherClientsWakeAndStopKeepTheText(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	for _, client := range []string{"claude", "pi"} {
		h.hook(client, "SessionStart", "r")
		h.hook(client, "UserPromptSubmit", "r")
		h.send("s", client+":r", "whole text", false)
		contains(t, h.hook(client, "Stop", "r", stopInactive).str("reason"), "whole text")
		h.hook(client, "Stop", "r", stopActive)
		h.send("s", client+":r", "woken text", false)
		contains(t, h.openHook(client, texts0BackgroundWait(), "r").wait(t).str("wake"), "woken text")
	}
}
