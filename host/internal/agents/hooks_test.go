package agents

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/store"
)

var (
	stopInactive = map[string]any{"stop_hook_active": false}
	stopActive   = map[string]any{"stop_hook_active": true}
)

func TestSessionNames(t *testing.T) {
	h := start(t)
	// A session is named <client>@<cwd basename>#<the last 4 letters and digits of its client session id>.
	h.hook("claude", "SessionStart", "9f3a2b7c-0d1e-4f5a-8b6c-aa11bb22cc33")
	h.hook("claude", "UserPromptSubmit", "short") // any event creates the session
	a := h.session("claude:9f3a2b7c-0d1e-4f5a-8b6c-aa11bb22cc33")
	if a.Client != "claude" || a.Name != "claude@proj#cc33" || a.Cwd != "/work/proj" || a.Status != "idle" || a.Note != "" || a.Listening {
		t.Fatalf("claude:9f3a… = %+v", a)
	}
	eq(t, h.session("claude:short").Name, "claude@proj#hort")
	eq(t, h.status("claude:short"), "working")
	// Ids shorter than 4 give what they have.
	h.hook("codex", "SessionStart", "x", map[string]any{"cwd": nil})
	eq(t, h.session("codex:x").Name, "codex@session#x") // no cwd: "session"
	eq(t, h.session("codex:x").Cwd, "")
	h.hook("codex", "SessionStart", "w", map[string]any{"cwd": `C:\work\winproj\`})
	eq(t, h.session("codex:w").Name, "codex@winproj#w")

	// The same ending in the same directory: the name takes more of the id, also against an offline session.
	h.hook("claude", "SessionEnd", "9f3a2b7c-0d1e-4f5a-8b6c-aa11bb22cc33")
	h.hook("claude", "SessionStart", "00000000-0000-4000-8000-0000ffffcc33")
	eq(t, h.session("claude:00000000-0000-4000-8000-0000ffffcc33").Name, "claude@proj#fcc33")

	// A session coming back keeps its name; one whose name another session took with set_profile gets a longer one.
	h.hook("claude", "SessionStart", "9f3a2b7c-0d1e-4f5a-8b6c-aa11bb22cc33", map[string]any{"source": "resume"})
	eq(t, h.session("claude:9f3a2b7c-0d1e-4f5a-8b6c-aa11bb22cc33").Name, "claude@proj#cc33")
	h.hook("claude", "SessionEnd", "short")
	eq(t, h.claude("x2", "set_profile", map[string]any{"name": "claude@proj#hort"}).status, 200)
	h.hook("claude", "SessionStart", "short")
	eq(t, h.session("claude:short").Name, "claude@proj#short")
}

func TestHookInputAndActivity(t *testing.T) {
	h := start(t)
	for _, input := range []map[string]any{
		{"hook_event_name": "SessionStart"},
		{"hook_event_name": "SessionStart", "session_id": ""},
		{"hook_event_name": "Stop", "session_id": 7},
	} {
		status, payload, err := h.post(context.Background(), "/api/hook", map[string]any{"client": "claude", "input": input})
		if err != nil || status != 200 || payload["output"] != nil {
			t.Fatalf("%v: %d %v %v", input, status, payload, err)
		}
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_sessions"), 0)
	status, _, _ := h.post(context.Background(), "/api/hook", map[string]any{"client": "cursor", "input": map[string]any{"session_id": "a"}})
	eq(t, status, 400)
	status, _, _ = h.post(context.Background(), "/api/hook", map[string]any{"client": "claude"})
	eq(t, status, 400)

	h.hook("claude", "SessionStart", "a")
	eq(t, h.session("claude:a").LastActiveAt, store.ISO(h.t0))
	h.at(5 * time.Second)
	h.hook("claude", "PreToolUse", "a", map[string]any{"tool_use_id": "toolu_x"})
	eq(t, h.session("claude:a").LastActiveAt, store.ISO(h.t0.Add(5*time.Second)))
	eq(t, h.status("claude:a"), "idle") // PreToolUse does not change the status
	if out := h.hook("claude", "UnknownEvent", "a"); out != nil {
		t.Fatalf("unknown event printed %v", out)
	}
}

func TestSessionEnd(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "a")
	eq(t, h.codex("a", "listen", map[string]any{"on": true}).result["listening"], any(true))
	if out := h.hook("codex", "SessionEnd", "a", map[string]any{"reason": "exit"}); out != nil {
		t.Fatalf("SessionEnd printed %v", out)
	}
	eq(t, h.status("codex:a"), "offline")
	eq(t, h.session("codex:a").Listening, false)
}

func TestSessionStartIntroduction(t *testing.T) {
	h := start(t)
	alone := h.hook("claude", "SessionStart", "a").context()
	if !strings.HasPrefix(alone, prefix+" This conversation is claude@proj#a (claude:a) on n2n-nexus") {
		t.Fatal(alone)
	}
	contains(t, alone, "No other AI sessions are online.")
	contains(t, alone, texts.SessionStartClosing)

	h.hook("codex", "SessionStart", "b")
	h.codex("b", "set_profile", map[string]any{"note": "fixing login"})
	for _, id := range []string{"c", "d", "e", "f", "g"} {
		h.hook("codex", "SessionStart", id)
	}
	h.hook("codex", "SessionEnd", "g") // offline sessions are not listed

	text := h.hook("claude", "SessionStart", "h").context()
	contains(t, text, "6 other AI sessions are online:")
	contains(t, text, "- codex@proj#b (box · Linux) (codex:b), codex, idle, /work/proj: fixing login")
	notContains(t, text, "(codex:g)")
	contains(t, text, "This conversation is claude@proj#h (claude:h)")
	notContains(t, text, "- claude@proj#h (")
	contains(t, text, "...and 1 more")
	contains(t, text, texts.StatusNote)
	if !strings.HasSuffix(text, texts.SessionStartClosing+"\n"+texts.CollaborationRules) {
		t.Fatal(text)
	}
	eq(t, h.status("claude:h"), "idle")

	// One other session: singular.
	h2 := start(t)
	h2.hook("codex", "SessionStart", "x")
	contains(t, h2.hook("codex", "SessionStart", "y").context(), "1 other AI session is online:")
}

func TestStaleSessionsGoOfflineAndComeBack(t *testing.T) {
	h := start(t, listenWait(10*time.Second))
	stale := ms(timing.StaleSessionMs)
	h.hook("codex", "SessionStart", "idle")
	h.hook("codex", "UserPromptSubmit", "busy")
	h.hook("codex", "SessionStart", "waiting")
	eq(t, h.codex("waiting", "listen", map[string]any{"on": true}).status, 200)
	waiting := h.openHook("codex", "Stop", "waiting", stopActive) // a Stop hook is waiting for messages
	h.untilStatus("codex:waiting", "listening")

	h.at(stale + time.Second)
	text := h.hook("claude", "SessionStart", "new").context()
	eq(t, h.status("codex:idle"), "offline")
	eq(t, h.status("codex:busy"), "offline")
	eq(t, h.status("codex:waiting"), "listening")
	contains(t, text, "1 other AI session is online:")
	contains(t, text, "(codex:waiting)")

	// Any event brings a session back, a direct-message tool call or Claude's PreToolUse included.
	h.hook("codex", "UserPromptSubmit", "idle")
	eq(t, h.status("codex:idle"), "working")
	self := h.codex("busy", "peers", nil).result["self"].(map[string]any)
	eq(t, self["status"], any("working"))
	h.hook("claude", "SessionStart", "quiet")
	h.at(2*stale + 2*time.Second)
	h.hook("codex", "UserPromptSubmit", "idle") // expires claude:quiet
	eq(t, h.status("claude:quiet"), "offline")
	h.hook("claude", "PreToolUse", "quiet", map[string]any{"tool_use_id": "toolu_quiet"})
	eq(t, h.status("claude:quiet"), "working")

	h.codex("waiting", "listen", map[string]any{"on": false})
	if out := waiting.wait(t); out != nil {
		t.Fatalf("listening Stop printed %v", out)
	}
}

func TestUserPromptSubmitNotification(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "sender")
	h.hook("claude", "SessionStart", "rcv")
	if out := h.hook("claude", "UserPromptSubmit", "rcv"); out != nil {
		t.Fatalf("nothing to tell, got %v", out)
	}
	long := strings.Repeat("x", testContract.Hook.Limits.PreviewChars+50) + "\r\nsecond line"
	first := h.send("sender", "claude:rcv", long, false)
	for i := 2; i <= 7; i++ {
		h.send("sender", "claude:rcv", "message "+string(rune('0'+i)), false)
	}
	out := h.hook("claude", "UserPromptSubmit", "rcv")
	eq(t, out["hookSpecificOutput"].(map[string]any)["hookEventName"], any("UserPromptSubmit"))
	text := out.context()
	if !strings.HasPrefix(text, prefix+" 7 unread direct messages:") {
		t.Fatal(text)
	}
	// Each listed message is shown whole, between its header and end lines, with how to answer it.
	contains(t, text, "--- Message "+first+" from codex@proj#nder (box · Linux) (codex:sender) at ")
	contains(t, text, " ---\n"+long+"\n"+fmt.Sprintf(texts.MessageEnd, first)+"\n"+fmt.Sprintf(texts.ReplyInstruction, first)+"\n")
	contains(t, text, "\nmessage 5\n")
	notContains(t, text, "\nmessage 6\n")
	contains(t, text, "...and 2 more")
	contains(t, text, texts.MessageTrustNote+" "+texts.NotifyClosing+"\n"+fmt.Sprintf(texts.ReplyTool, "mcp__n2n-nexus__reply")+"\n"+texts.ReadRest)
	eq(t, h.status("claude:rcv"), "working")

	// Every unread message was marked notified, so a tool call adds nothing.
	if out := h.hook("claude", "PostToolUse", "rcv"); out != nil {
		t.Fatalf("PostToolUse repeated %v", out)
	}
	// The next prompt only counts them while they are unread: each was announced in full once
	// (a prompt's notification is no turn of its own, so it marks nothing read).
	again := h.hook("claude", "UserPromptSubmit", "rcv").context()
	contains(t, again, fmt.Sprintf(texts.EarlierUnread, 7))
	notContains(t, again, "\nmessage 1\n")
}

func TestPreviewCountsUTF16Units(t *testing.T) {
	h := start(t)
	n := testContract.Hook.Limits.PreviewChars
	emoji := "\U0001F600" // two UTF-16 units
	eq(t, h.ag.preview(strings.Repeat(emoji, n)), strings.Repeat(emoji, n/2))
	eq(t, h.ag.preview("x"+strings.Repeat(emoji, n)), "x"+strings.Repeat(emoji, (n-1)/2))
	eq(t, h.ag.preview("a\rb\nc"), "a\rb")
}

func TestNoticesAlone(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "watcher")
	h.hook("codex", "SessionStart", "target")
	h.send("watcher", "codex:target", "ping", true)
	h.codex("target", "read", nil)
	h.hook("codex", "Stop", "target")
	eq(t, h.hook("codex", "UserPromptSubmit", "watcher").context(), prefix+" Notices:\n- codex@proj#rget (codex:target) finished its turn.")
	if out := h.hook("codex", "UserPromptSubmit", "watcher"); out != nil {
		t.Fatalf("notices are delivered once, got %v", out)
	}
}

func TestPostToolUseOnlyNew(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.send("s", "claude:r", "msg-one", false)
	first := h.hook("claude", "PostToolUse", "r", map[string]any{"tool_use_id": "t1", "tool_name": "Bash"})
	eq(t, first["hookSpecificOutput"].(map[string]any)["hookEventName"], any("PostToolUse"))
	contains(t, first.context(), prefix+" 1 new direct message:")
	contains(t, first.context(), "msg-one")
	eq(t, h.status("claude:r"), "working")
	if out := h.hook("claude", "PostToolUse", "r"); out != nil {
		t.Fatalf("repeated %v", out)
	}
	h.send("s", "claude:r", "msg-two", false)
	second := h.hook("claude", "PostToolUse", "r").context()
	contains(t, second, "msg-two")
	notContains(t, second, "msg-one")
}

func TestStopBlocksOnce(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	if out := h.hook("claude", "Stop", "r", stopInactive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")

	h.send("s", "claude:r", "please look", false)
	h.hook("claude", "UserPromptSubmit", "r") // already announced: Stop still blocks, counting it
	blocked := h.hook("claude", "Stop", "r", stopInactive)
	eq(t, blocked.str("decision"), "block")
	if !strings.HasPrefix(blocked.str("reason"), prefix+" "+fmt.Sprintf(texts.EarlierUnread, 1)) {
		t.Fatal(blocked)
	}
	notContains(t, blocked.str("reason"), "please look")
	contains(t, blocked.str("reason"), texts.MessageTrustNote+" "+texts.StopClosing)
	if strings.Contains(blocked.str("reason"), "Automatic turn") { // no limit by default, so no count
		t.Fatal(blocked)
	}
	eq(t, h.status("claude:r"), "working")

	if out := h.hook("claude", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")
}

func TestStopShowsMessagesWholeAndMarksThemRead(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	asked := h.claude("r", "send", map[string]any{"to": "codex:s", "text": "status?"}).result["messageId"].(string)
	sent := h.codex("s", "reply", map[string]any{"messageId": asked, "text": "deploy it\nthen report"})
	eq(t, sent.status, 200)
	id := sent.result["messageId"].(string)

	blocked := h.hook("claude", "Stop", "r", stopInactive)
	eq(t, blocked.str("decision"), "block")
	contains(t, blocked.str("reason"), strings.Join([]string{
		fmt.Sprintf(texts.MessageReplyTo, asked),
		"deploy it\nthen report",
		fmt.Sprintf(texts.MessageEnd, id),
		fmt.Sprintf(texts.ReplyInstruction, id),
	}, "\n"))
	contains(t, blocked.str("reason"), texts.MessageTrustNote+" "+texts.StopClosing)
	notContains(t, blocked.str("reason"), texts.ReadRest)
	// Shown whole in the text that drives the turn: read, so read and the next Stop have nothing left.
	eq(t, len(h.claude("r", "read", nil).result["messages"].([]any)), 0)
	h.hook("claude", "Stop", "r", stopActive)
	if out := h.hook("claude", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("Stop held again: %v", out)
	}
}

func TestReplyMarksTheAnsweredMessageRead(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "UserPromptSubmit", "r")
	id := h.send("s", "claude:r", "check the logs", false)
	// Shown during the turn: it stays unread, so a turn that ignores it is held at Stop ...
	contains(t, h.hook("claude", "PostToolUse", "r").context(), "check the logs")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'unread'", id), 1)
	// ... but answering it with reply marks it read: no Stop hold, no automatic turn, nothing for read.
	eq(t, h.claude("r", "reply", map[string]any{"messageId": id, "text": "logs are clean", "expectsReply": false}).status, 200)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'read' AND read_at IS NOT NULL", id), 1)
	if out := h.hook("claude", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("Stop held for an answered message: %v", out)
	}
	eq(t, len(h.claude("r", "read", nil).result["messages"].([]any)), 0)
}

func TestNoReplyMessageReadOnlyWhenAPromptShowsIt(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "UserPromptSubmit", "r")
	// Shown after a tool call: the context can be a sub-agent's, so the message stays unread ...
	first := h.codex("s", "send", map[string]any{"to": "claude:r", "text": "done with part one", "expectsReply": false}).result["messageId"].(string)
	contains(t, h.hook("claude", "PostToolUse", "r").context(), "done with part one")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'unread'", first), 1)
	// ... and the next prompt counts it, so the conversation can read it.
	h.hook("claude", "Stop", "r", stopActive)
	second := h.codex("s", "send", map[string]any{"to": "claude:r", "text": "done with part two", "expectsReply": false}).result["messageId"].(string)
	ctx := h.hook("claude", "UserPromptSubmit", "r").context()
	contains(t, ctx, fmt.Sprintf(texts.EarlierUnread, 1))
	contains(t, ctx, "done with part two")
	// Shown with the prompt itself, the no-reply message is read; the earlier one waits for read.
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'read'", second), 1)
	read := h.claude("r", "read", nil).result["messages"].([]any)
	eq(t, len(read), 1)
	eq(t, read[0].(map[string]any)["messageId"], any(first))
}

func TestNotificationTextBudget(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	budget := testContract.Hook.Limits.NotifyTextChars
	emoji := "\U0001F600" // two UTF-16 units
	big := strings.Repeat("y", budget-1) + emoji + "tail"
	first := h.send("s", "claude:r", big, false)
	second := h.send("s", "claude:r", "small", false)

	reason := h.hook("claude", "Stop", "r", stopInactive).str("reason")
	// The emoji does not fit whole: the cut keeps budget-1 units and never splits it.
	contains(t, reason, " ---\n"+strings.Repeat("y", budget-1)+"\n"+fmt.Sprintf(texts.MessageCut, budget-1, budget+5)+"\n"+fmt.Sprintf(texts.MessageEnd, first))
	// The one unit left of the budget goes to the second message.
	contains(t, reason, " ---\ns\n"+fmt.Sprintf(texts.MessageCut, 1, 5)+"\n"+fmt.Sprintf(texts.MessageEnd, second))
	contains(t, reason, texts.ReadRest)
	// Cut messages stay unread: read returns them whole.
	read := h.claude("r", "read", nil).result["messages"].([]any)
	eq(t, len(read), 2)
	eq(t, read[0].(map[string]any)["text"], any(big))
	eq(t, read[1].(map[string]any)["text"], any("small"))
}

// ---------------------------------------------------------------------------
// Background wait
// ---------------------------------------------------------------------------

func TestBackgroundWaitWakes(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	waiting := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "wake up", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), prefix+" 1 new direct message:")
	contains(t, out.str("wake"), "wake up")
	eq(t, h.status("claude:r"), "working")
	// The woken turn's own prompt does not announce again what the wake just announced.
	if out := h.hook("claude", "UserPromptSubmit", "r"); out != nil {
		t.Fatalf("woken prompt repeated the wake: %v", out)
	}
	// The wake showed the message whole and marked it read: a later prompt and read have nothing left.
	h.at(ms(timing.WakePromptWindowMs) + time.Second)
	if out := h.hook("claude", "UserPromptSubmit", "r"); out != nil {
		t.Fatalf("prompt after the wake: %v", out)
	}
	eq(t, len(h.claude("r", "read", nil).result["messages"].([]any)), 0)
}

func texts0BackgroundWait() string { return testContract.Hook.BackgroundWaitEvent }

func TestBackgroundWaitWhileTurnEnds(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.send("s", "codex:r", "before the turn ended", false)
	waiting := h.openHook("codex", texts0BackgroundWait(), "r") // started alongside Stop
	h.until("wait registered", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return len(h.ag.backgroundWaits("codex:r")) == 1 })
	eq(t, h.status("codex:r"), "working")

	// Stop announces the unread message itself; the wait must not repeat it.
	eq(t, h.hook("codex", "Stop", "r", stopInactive).str("decision"), "block")
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "listening")
	h.send("s", "codex:r", "after", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), "after")
	notContains(t, out.str("wake"), "before the turn ended")
	notContains(t, out.str("wake"), "mcp__n2n-nexus__reply") // the Claude Code tool name is for Claude sessions only
}

func TestBackgroundWaitEnds(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r")

	cancelled := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.hook("claude", "UserPromptSubmit", "r")
	if out := cancelled.wait(t); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "working")

	h.hook("claude", "Stop", "r")
	timedOut := h.openHook("claude", texts0BackgroundWait(), "r")
	eq(t, timedOut.wait(t)["timeout"], any(true))
	eq(t, h.status("claude:r"), "idle")

	gone := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	gone.cancel()
	h.untilStatus("claude:r", "idle")
}

func TestListeningStopDeliversBeforeBackgroundWait(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	background := h.openHook("codex", texts0BackgroundWait(), "r") // registered first
	h.until("wait registered", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return len(h.ag.backgroundWaits("codex:r")) == 1 })
	listening := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.until("listening stop held", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return h.ag.listeningStop("codex:r") })
	h.send("s", "codex:r", "for the listening stop", false)
	stop := listening.wait(t)
	eq(t, stop.str("decision"), "block")
	contains(t, stop.str("reason"), "for the listening stop")
	eq(t, background.wait(t)["timeout"], any(true)) // it did not take the message

	// The next listening Stop times out; the client's next background wait delivers what arrives then.
	h.hook("codex", "Stop", "r", stopActive)
	again := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "for the background wait", false)
	out := again.wait(t)
	contains(t, out.str("wake"), "for the background wait")
	notContains(t, out.str("wake"), "for the listening stop")
}

func TestListenOnLeavesListeningWhenNothingWaits(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil { // listening Stop times out
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
	background := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	eq(t, background.wait(t)["timeout"], any(true))
	eq(t, h.status("codex:r"), "idle") // the client asks no more: it can go stale
}

func TestBackgroundWaitCountsAsActivity(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopInactive)
	later := ms(timing.StaleSessionMs) + time.Second
	h.at(later)
	background := h.openHook("codex", texts0BackgroundWait(), "r")
	eq(t, background.wait(t)["timeout"], any(true))
	eq(t, h.session("codex:r").LastActiveAt, store.ISO(h.t0.Add(later)))
	eq(t, h.status("codex:r"), "idle")
	h.hook("claude", "SessionStart", "other") // any event expires stale sessions before the next wait
	eq(t, h.status("codex:r"), "idle")
}

func TestBackgroundWaitUnknownSession(t *testing.T) {
	h := start(t)
	if out := h.hook("claude", texts0BackgroundWait(), "nobody"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_sessions"), 0)
}

// ---------------------------------------------------------------------------
// Automatic turn limit
// ---------------------------------------------------------------------------

func TestAutoTurnLimitWakes(t *testing.T) {
	h := start(t, listenWait(2*time.Second), maxTurns(2))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)

	for _, n := range []string{"1", "2"} {
		waiting := h.openHook("claude", texts0BackgroundWait(), "r")
		h.untilStatus("claude:r", "listening")
		h.send("s", "claude:r", "ping "+n, false)
		wake := waiting.wait(t).str("wake")
		contains(t, wake, "ping "+n)
		contains(t, wake, "Automatic turn "+n+" of 2 since your user's last prompt; after turn 2, messages wait until your user prompts again.")
		h.claude("r", "read", nil)
		// The woken turn as the client runs it: its prompt (within the wake window), then the end of the turn.
		h.at(ms(timing.WakePromptWindowMs) / 2)
		h.hook("claude", "UserPromptSubmit", "r")
		h.hook("claude", "Stop", "r", stopInactive)
	}

	// The limit is reached: the wait still holds (meeting news would wake it), but the message only waits, unread and not announced.
	capped := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "ping 3", false)
	if out := capped.wait(t); out.str("timeout") != "" || out["timeout"] != true {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'claude:r' AND status = 'unread' AND notified_at IS NULL"), 1)

	// A real prompt (no wake just before it) starts counting again and announces the message.
	contains(t, h.hook("claude", "UserPromptSubmit", "r").context(), "ping 3")
	h.claude("r", "read", nil)
	h.hook("claude", "Stop", "r", stopInactive)
	again := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "ping 4", false)
	contains(t, again.wait(t).str("wake"), "Automatic turn 1 of 2")
}

func TestAutoTurnPromptAfterWakeWindowResets(t *testing.T) {
	h := start(t, listenWait(2*time.Second), maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	waiting := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "ping", false)
	contains(t, waiting.wait(t).str("wake"), "Automatic turn 1 of 1")
	h.claude("r", "read", nil)
	// A prompt later than the wake window is the user's: the count starts again.
	h.at(ms(timing.WakePromptWindowMs) + time.Second)
	h.hook("claude", "UserPromptSubmit", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	again := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "pong", false)
	contains(t, again.wait(t).str("wake"), "Automatic turn 1 of 1")
}

func TestAutoTurnLimitStop(t *testing.T) {
	h := start(t, maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.send("s", "codex:r", "first", false)
	blocked := h.hook("codex", "Stop", "r", stopInactive)
	eq(t, blocked.str("decision"), "block")
	contains(t, blocked.str("reason"), "Automatic turn 1 of 1")
	h.send("s", "codex:r", "second", false)
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestAutoTurnLimitListeningStop(t *testing.T) {
	h := start(t, maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	first := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "one", false)
	contains(t, first.wait(t).str("reason"), "Automatic turn 1 of 1")
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestNoAutoTurnLimit(t *testing.T) {
	h := start(t, maxTurns(0))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	for i := 0; i < 3; i++ {
		h.send("s", "codex:r", "m", false)
		out := h.hook("codex", "Stop", "r", stopInactive)
		eq(t, out.str("decision"), "block")
		notContains(t, out.str("reason"), "Automatic turn")
		h.codex("r", "read", nil)
	}
}

// ---------------------------------------------------------------------------
// Listen mode
// ---------------------------------------------------------------------------

func TestListeningStopWakes(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	started := time.Now()
	waiting := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "wake up", false)
	out := waiting.wait(t)
	if time.Since(started) >= listenMS*time.Millisecond {
		t.Fatalf("took %v", time.Since(started))
	}
	eq(t, out.str("decision"), "block")
	contains(t, out.str("reason"), prefix+" 1 new direct message:")
	contains(t, out.str("reason"), "wake up")
	eq(t, h.status("codex:r"), "working")
}

func TestListeningStopTimesOut(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	if out := h.hook("codex", "Stop", "r"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")

	h.send("s", "codex:r", "old news", false)
	h.hook("codex", "UserPromptSubmit", "r")
	started := time.Now()
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) < (listenMS-20)*time.Millisecond {
		t.Fatalf("returned after %v", time.Since(started))
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestListeningStopReturnsPendingAtOnce(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.send("s", "codex:r", "during continuation", false)
	out := h.hook("codex", "Stop", "r", stopActive)
	contains(t, out.str("reason"), "during continuation")
	eq(t, h.status("codex:r"), "working")
}

func TestListeningStopWokenByNotice(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "watcher")
	h.hook("codex", "SessionStart", "target")
	h.send("watcher", "codex:target", "do it", true)
	h.codex("watcher", "listen", map[string]any{"on": true})
	waiting := h.openHook("codex", "Stop", "watcher")
	h.untilStatus("codex:watcher", "listening")
	h.codex("target", "read", nil)
	if out := h.hook("codex", "Stop", "target"); out != nil {
		t.Fatal(out)
	}
	out := waiting.wait(t)
	eq(t, out.str("decision"), "block")
	if out.str("reason") != prefix+" Notices:\n- codex@proj#rget (codex:target) finished its turn." {
		t.Fatal(out.str("reason"))
	}
}

func TestListeningStopClientDisconnects(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "r")
	h.claude("r", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "r")
	h.untilStatus("claude:r", "listening")
	waiting.cancel()
	h.untilStatus("claude:r", "idle")
}

func TestListeningStopEndsOnSessionEnd(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "se")
	h.hook("codex", "SessionStart", "sender")
	h.claude("se", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "se")
	h.untilStatus("claude:se", "listening")
	if out := h.hook("claude", "SessionEnd", "se"); out != nil {
		t.Fatal(out)
	}
	if out := waiting.wait(t); out != nil {
		t.Fatal(out)
	}
	h.send("sender", "claude:se", "after the end", false)
	eq(t, h.status("claude:se"), "offline")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'claude:se' AND notified_at IS NULL"), 1)
}

func TestListenOffEndsWait(t *testing.T) {
	h := start(t, listenWait(30*time.Second))
	h.hook("claude", "SessionStart", "off")
	h.claude("off", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "off")
	h.untilStatus("claude:off", "listening")
	started := time.Now()
	eq(t, h.claude("off", "listen", map[string]any{"on": false}).result["listening"], any(false))
	if out := waiting.wait(t); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	eq(t, h.status("claude:off"), "idle")
}

func TestRestartResetsListening(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.stop()
	// Leave the row listening, as a host that crashed during a wait would.
	st, err := store.Open(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB.Exec("UPDATE agent_sessions SET status = 'listening' WHERE id = 'codex:r'"); err != nil {
		t.Fatal(err)
	}
	st.Close()
	h.open()
	eq(t, h.status("codex:r"), "idle")
	eq(t, h.session("codex:r").Listening, true)
	// Idle again, it can go stale.
	h.at(ms(timing.StaleSessionMs) + time.Second)
	h.hook("codex", "SessionStart", "other")
	eq(t, h.status("codex:r"), "offline")
}

func TestCloseEndsHeldWaits(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "sd")
	h.claude("sd", "listen", map[string]any{"on": true})
	h.hook("codex", "SessionStart", "bw")
	h.hook("codex", "Stop", "bw")
	listening := h.openHook("claude", "Stop", "sd")
	background := h.openHook("codex", texts0BackgroundWait(), "bw")
	h.untilStatus("claude:sd", "listening")
	h.untilStatus("codex:bw", "listening")
	started := time.Now()
	h.ag.Close()
	if out := listening.wait(t); out != nil {
		t.Fatal(out)
	}
	if out := background.wait(t); out["timeout"] != true {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	// A wait asked for after Close ends at once.
	started = time.Now()
	if out := h.hook("codex", texts0BackgroundWait(), "bw"); out["timeout"] != true {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
}

// ---------------------------------------------------------------------------
// Idle subscriptions and expiry
// ---------------------------------------------------------------------------

func TestIdleSubscriptions(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "w")
	h.hook("claude", "SessionStart", "t")

	h.send("w", "claude:t", "task", true)
	h.claude("t", "read", nil)
	h.hook("claude", "Stop", "t")
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "claude@proj#t (claude:t) finished its turn.")
	h.hook("claude", "Stop", "t") // the subscription was one-shot
	if out := h.hook("codex", "UserPromptSubmit", "w"); out != nil {
		t.Fatal(out)
	}

	// Entering listen mode counts as finishing the turn.
	h.send("w", "claude:t", "task 2", true)
	h.claude("t", "read", nil)
	h.claude("t", "listen", map[string]any{"on": true})
	if out := h.hook("claude", "Stop", "t"); out != nil { // waits, then idle
		t.Fatal(out)
	}
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "finished its turn.")

	h.send("w", "claude:t", "task 3", true)
	h.hook("claude", "SessionEnd", "t")
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "claude@proj#t (claude:t) went offline.")
}

func TestIdleSubscriptionOnAStaleSession(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "w")
	h.hook("claude", "SessionStart", "t")
	h.hook("claude", "UserPromptSubmit", "t") // working, then nothing more: it goes stale
	h.send("w", "claude:t", "task", true)
	stale := ms(timing.StaleSessionMs)
	h.at(stale / 2)
	h.hook("codex", "UserPromptSubmit", "w")
	h.at(stale + time.Second)
	// Any later event finds t stale and sets it offline: the subscriber is told.
	ctx := h.hook("codex", "UserPromptSubmit", "w").context()
	eq(t, h.status("claude:t"), "offline")
	contains(t, ctx, "claude@proj#t (claude:t) went offline.")
}

func TestStaleSessionWakesAWaitingSubscriber(t *testing.T) {
	h := start(t, listenWait(time.Second))
	h.hook("codex", "SessionStart", "w")
	h.hook("claude", "SessionStart", "t")
	h.hook("claude", "UserPromptSubmit", "t") // working, then never heard of again
	h.send("w", "claude:t", "task", true)
	h.hook("codex", "Stop", "w", stopActive)
	// w only waits in the background; nothing else happens until t is stale.
	if out := h.openHook("codex", texts0BackgroundWait(), "w").wait(t); out["timeout"] != true {
		t.Fatal(out)
	}
	h.at(ms(timing.StaleSessionMs) + time.Second)
	out := h.openHook("codex", texts0BackgroundWait(), "w").wait(t)
	contains(t, out.str("wake"), "claude@proj#t (claude:t) went offline.")
}

func TestIdleSubscriptionTTL(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "w")
	h.hook("codex", "SessionStart", "t")
	h.send("w", "codex:t", "task", true)
	h.codex("t", "read", nil)
	h.at(ms(timing.IdleSubscriptionTtlMs) + time.Second)
	h.hook("codex", "Stop", "t")
	if out := h.hook("codex", "UserPromptSubmit", "w"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_idle_subscriptions"), 0)
}

func TestMessageExpiry(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	id := h.send("s", "claude:r", "stale request\nmore", false)
	h.at(ms(timing.MessageTtlMs) + time.Second)
	h.hook("codex", "SessionStart", "other") // any hook runs the expiry check
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'expired'", id), 1)
	eq(t, h.hook("codex", "UserPromptSubmit", "s").context(), prefix+" Notices:\n- Your message to claude@proj#r (claude:r) expired unread: \"stale request\"")
	if out := h.hook("claude", "UserPromptSubmit", "r"); out != nil {
		t.Fatal(out)
	}
	eq(t, len(h.claude("r", "read", nil).result["messages"].([]any)), 0)
}

func TestToolUseBinding(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "a")
	if out := h.hook("claude", "PreToolUse", "a", map[string]any{"tool_use_id": "toolu_1"}); out != nil {
		t.Fatal(out)
	}
	call := func(id string) toolReply {
		return h.call(map[string]any{"client": "claude", "toolUseId": id}, "peers", nil)
	}
	eq(t, call("toolu_1").result["self"].(map[string]any)["id"], any("claude:a"))
	r := call("toolu_unknown")
	eq(t, r.status, 400)
	eq(t, r.error, texts.NoAgentSessionError)

	// A PreToolUse without tool_use_id binds nothing.
	h.hook("claude", "PreToolUse", "a")
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings"), 1)

	h.at(ms(timing.ToolUseBindingTtlMs) + time.Second)
	r = call("toolu_1")
	eq(t, r.status, 400)
	eq(t, r.error, texts.NoAgentSessionError)
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings"), 0)
}

func TestSeveralHostsAtOnce(t *testing.T) {
	// The coordinators share nothing: a wait on one host is not woken by another.
	h1 := start(t, listenWait(time.Minute))
	h2 := start(t)
	for _, h := range []*harness{h1, h2} {
		h.hook("codex", "SessionStart", "s")
		h.hook("codex", "SessionStart", "r")
		h.codex("r", "listen", map[string]any{"on": true})
	}
	waiting := h1.openHook("codex", "Stop", "r")
	h1.untilStatus("codex:r", "listening")
	h2.send("s", "codex:r", "on host 2", false)
	select {
	case <-waiting.done:
		t.Fatal("host 1 woke for a message on host 2")
	case <-time.After(100 * time.Millisecond):
	}
	h1.send("s", "codex:r", "on host 1", false)
	contains(t, waiting.wait(t).str("reason"), "on host 1")
}

func TestSessionMachine(t *testing.T) {
	h := start(t)
	mac := map[string]any{"machine": map[string]any{"hostname": "mac-host", "platform": "darwin", "environment": "", "utcOffset": float64(480)}}
	h.hook("claude", "SessionStart", "mac", mac)
	h.hook("codex", "SessionStart", "win", map[string]any{"machine": map[string]any{"hostname": "win-host", "platform": "win32", "environment": "", "utcOffset": float64(480)}})

	// peers reports what the hooks said.
	p := h.codex("win", "peers", nil).result["peers"].([]any)[0].(map[string]any)
	eq(t, p["hostname"], any("mac-host"))
	eq(t, p["platform"], any("darwin"))
	eq(t, p["utcOffset"], any(float64(480)))
	eq(t, p["label"], any(""))

	// The introduction and a notification name the machine.
	contains(t, h.hook("codex", "SessionStart", "win").context(), "- claude@proj#mac (mac-host · macOS) (claude:mac), claude, ")
	h.claude("mac", "send", map[string]any{"to": "codex:win", "text": "hi"})
	contains(t, h.hook("codex", "UserPromptSubmit", "win").context(), " from claude@proj#mac (mac-host · macOS) (claude:mac) at ")

	// A label replaces the hostname; "" removes it again.
	eq(t, h.claude("mac", "set_profile", map[string]any{"label": "mac-air"}).result["profile"].(map[string]any)["label"], any("mac-air"))
	h.claude("mac", "send", map[string]any{"to": "codex:win", "text": "again"})
	contains(t, h.hook("codex", "UserPromptSubmit", "win").context(), " from claude@proj#mac (mac-air · macOS) (claude:mac) at ")
	h.claude("mac", "set_profile", map[string]any{"label": ""})
	eq(t, h.session("claude:mac").machineName(), "mac-host · macOS")

	// Every event reports the machine again, and the latest report counts.
	h.hook("claude", "Stop", "mac", map[string]any{"stop_hook_active": true, "machine": map[string]any{"hostname": "mac-host", "platform": "wsl", "environment": "Ubuntu_26", "utcOffset": float64(-300)}})
	eq(t, h.session("claude:mac").machineName(), "mac-host · WSL Ubuntu_26")
	eq(t, h.session("claude:mac").UTCOffset, -300)
}

func TestHookWithoutMachineRefused(t *testing.T) {
	h := start(t)
	for name, m := range map[string]any{
		"missing":          nil,
		"unknown platform": map[string]any{"hostname": "box", "platform": "plan9", "environment": "", "utcOffset": float64(0)},
		"offset too large": map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": float64(5000)},
		"no environment":   map[string]any{"hostname": "box", "platform": "linux", "utcOffset": float64(0)},
		"offset fraction":  map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": float64(1.5)},
		"no hostname":      map[string]any{"hostname": "", "platform": "linux", "environment": "", "utcOffset": float64(0)},
	} {
		status, payload, err := h.post(context.Background(), "/api/hook", map[string]any{"client": "codex", "input": hookInput("SessionStart", "s", map[string]any{"machine": m})})
		if err != nil || status != 400 {
			t.Fatalf("%s: %d %v %v", name, status, payload, err)
		}
		contains(t, payload["error"].(string), "input.machine")
	}
	if s := h.session("codex:s"); s != nil {
		t.Fatalf("a refused event created the session: %+v", s)
	}
}

func TestSessionTitles(t *testing.T) {
	h := start(t)
	same := func(id, wantTitle, wantSource string) {
		t.Helper()
		s := h.session(id)
		eq(t, s.Title, wantTitle)
		eq(t, s.TitleSource, wantSource)
	}
	h.hook("codex", "SessionStart", "a")
	same("codex:a", "", "")
	h.hook("codex", "SessionStart", "a", map[string]any{"title": "Plan the release"})
	same("codex:a", "Plan the release", "client")
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": "Release 2.0"})
	same("codex:a", "Release 2.0", "client")
	h.hook("codex", "Stop", "a", map[string]any{"title": "Release 2.1", "stop_hook_active": false})
	same("codex:a", "Release 2.1", "client")
	// Other events and empty titles change nothing.
	h.hook("codex", "PostToolUse", "a", map[string]any{"title": "from a tool call"})
	h.hook("codex", "PreToolUse", "a", map[string]any{"title": "from a tool call", "tool_use_id": "t1"})
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": ""})
	h.hook("codex", "UserPromptSubmit", "a")
	same("codex:a", "Release 2.1", "client")

	// The host cuts a long title to maxTitleChars characters (code points), as the client and set_profile count.
	limit := testContract.Hook.Limits.MaxTitleChars
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": strings.Repeat("t", limit-1) + "\U0001F600" + "rest"})
	same("codex:a", strings.Repeat("t", limit-1)+"\U0001F600", "client")
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": strings.Repeat("\U0001F600", limit/2+10)})
	same("codex:a", strings.Repeat("\U0001F600", limit/2+10), "client")

	// A title set with set_profile is the session's own until it clears it.
	eq(t, h.codex("a", "set_profile", map[string]any{"title": strings.Repeat("x", limit+1)}).status, 400)
	own := h.codex("a", "set_profile", map[string]any{"title": "Mine"})
	eq(t, own.status, 200)
	eq(t, own.result["profile"].(map[string]any)["title"], any("Mine"))
	same("codex:a", "Mine", "self")
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": "Client title"})
	h.hook("codex", "SessionStart", "a", map[string]any{"title": "Client title"})
	same("codex:a", "Mine", "self")

	// Shown in peers, in the introduction's list of other sessions and in notifications.
	h.hook("claude", "SessionStart", "b", map[string]any{"title": "Review"})
	peers := h.claude("b", "peers", nil)
	eq(t, peers.result["self"].(map[string]any)["title"], any("Review"))
	eq(t, peers.result["peers"].([]any)[0].(map[string]any)["title"], any("Mine"))
	intro := h.hook("claude", "SessionStart", "c").context()
	contains(t, intro, "- codex@proj#a (box · Linux) \"Mine\" (codex:a), codex, ")
	contains(t, intro, "- claude@proj#b (box · Linux) \"Review\" (claude:b), claude, ")
	h.send("a", "claude:c", "hello", false)
	contains(t, h.hook("claude", "UserPromptSubmit", "c").context(), " from codex@proj#a (box · Linux) \"Mine\" (codex:a) at ")
	// Without a title, only the name.
	h.claude("c", "send", map[string]any{"to": "codex:a", "text": "hi"})
	contains(t, h.hook("codex", "UserPromptSubmit", "a").context(), " from claude@proj#c (box · Linux) (claude:c) at ")

	// An empty title clears it, and the client's title applies again.
	cleared := h.codex("a", "set_profile", map[string]any{"title": ""})
	eq(t, cleared.result["profile"].(map[string]any)["title"], any(""))
	same("codex:a", "", "")
	h.hook("codex", "UserPromptSubmit", "a", map[string]any{"title": "Client title"})
	same("codex:a", "Client title", "client")
}
