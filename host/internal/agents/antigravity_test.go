package agents

import (
	"testing"
	"time"
)

// injected is the text an Antigravity hook output injects as a system message step, "" when none.
func (o hookOutput) injected() string {
	steps, _ := o["injectSteps"].([]any)
	if len(steps) != 1 {
		return ""
	}
	step, _ := steps[0].(map[string]any)
	msg, _ := step["systemMessage"].(map[string]any)
	s, _ := msg["systemMessage"].(string)
	return s
}

func (h *harness) antigravity(sessionID, tool string, args map[string]any) toolReply {
	h.t.Helper()
	return h.call(map[string]any{"client": "antigravity", "sessionId": sessionID}, tool, args)
}

func (h *harness) antigravityWaits(id string) int {
	h.ag.mu.Lock()
	defer h.ag.mu.Unlock()
	return len(h.ag.backgroundWaits(id))
}

func TestAntigravityIdentityAndOutputs(t *testing.T) {
	h := start(t)
	out := h.hook("antigravity", "SessionStart", "a")
	contains(t, out.injected(), texts.SessionStartClosing)
	if out["hookSpecificOutput"] != nil {
		t.Fatalf("Claude/Codex output shape for Antigravity: %v", out)
	}
	eq(t, h.status("antigravity:a"), "idle")

	// The conversation id names the session for tool calls.
	r := h.antigravity("a", "peers", nil)
	eq(t, r.status, 200)
	self, _ := r.result["self"].(map[string]any)
	eq(t, self["id"], any("antigravity:a"))
	eq(t, self["client"], any("antigravity"))
	if r := h.call(map[string]any{"client": "antigravity", "sessionId": ""}, "peers", nil); r.status == 200 {
		t.Fatal("an empty Antigravity session id named a session")
	}

	// Stop continues the turn with Antigravity's decision.
	h.hook("codex", "SessionStart", "s")
	h.hook("antigravity", "UserPromptSubmit", "a")
	h.send("s", "antigravity:a", "during the turn", false)
	stop := h.hook("antigravity", "Stop", "a", stopInactive)
	eq(t, stop.str("decision"), "continue")
	contains(t, stop.str("reason"), "during the turn")
	if out := h.hook("antigravity", "Stop", "a", stopActive); out != nil {
		t.Fatal(out)
	}

	// A held listening Stop continues it the same way.
	eq(t, h.antigravity("a", "listen", map[string]any{"on": true}).status, 200)
	h.hook("antigravity", "UserPromptSubmit", "a")
	listening := h.openHook("antigravity", "Stop", "a", stopInactive)
	h.untilStatus("antigravity:a", "listening")
	h.send("s", "antigravity:a", "while listening", false)
	held := listening.wait(t)
	eq(t, held.str("decision"), "continue")
	contains(t, held.str("reason"), "while listening")

	// Mid-turn news (a later invocation of the turn) is injected too.
	h.send("s", "antigravity:a", "mid turn", false)
	contains(t, h.hook("antigravity", "PostToolUse", "a").injected(), "mid turn")
}

func TestAntigravityTitleIsSetOnce(t *testing.T) {
	h := start(t)
	h.hook("antigravity", "SessionStart", "a", map[string]any{"title": "first prompt"})
	eq(t, h.session("antigravity:a").Title, "first prompt")
	h.hook("antigravity", "SessionStart", "a", map[string]any{"title": "second prompt"})
	h.hook("antigravity", "UserPromptSubmit", "a", map[string]any{"title": "a prompt"})
	h.hook("antigravity", "Stop", "a", map[string]any{"title": "a stop"})
	eq(t, h.session("antigravity:a").Title, "first prompt")

	// A title set with set_profile is not replaced either.
	h.hook("antigravity", "SessionStart", "b")
	eq(t, h.antigravity("b", "set_profile", map[string]any{"title": "own"}).status, 200)
	h.hook("antigravity", "SessionStart", "b", map[string]any{"title": "from the client"})
	eq(t, h.session("antigravity:b").Title, "own")
}

func TestAntigravityWaiterReminder(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	reminder := texts.WaiterReminder

	// A conversation resumed without SessionStart: its first prompt says the waiter is not running.
	contains(t, h.hook("antigravity", "UserPromptSubmit", "a").injected(), reminder)
	h.hook("antigravity", "Stop", "a", stopInactive)

	// With a waiter's wait open, the prompt says nothing about it.
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.until("wait registered", func() bool { return h.antigravityWaits("antigravity:a") == 1 })
	if out := h.hook("antigravity", "UserPromptSubmit", "a"); out != nil {
		t.Fatalf("prompt with a waiter: %v", out)
	}
	h.hook("antigravity", "Stop", "a", stopInactive)

	// The turn a wake began needs no reminder, although the wait that delivered it has ended.
	h.hook("codex", "SessionStart", "s")
	h.send("s", "antigravity:a", "wake up", false)
	contains(t, waiting.wait(t).str("wake"), "wake up")
	eq(t, h.antigravityWaits("antigravity:a"), 0)
	if out := h.hook("antigravity", "UserPromptSubmit", "a"); out != nil {
		t.Fatalf("woken prompt: %v", out)
	}

	// Unread news and the reminder come together.
	h.hook("antigravity", "Stop", "a", stopActive)
	h.at(ms(timing.WakePromptWindowMs) + time.Second)
	h.send("s", "antigravity:a", "for the prompt", false)
	text := h.hook("antigravity", "UserPromptSubmit", "a").injected()
	contains(t, text, "for the prompt")
	contains(t, text, reminder)

	// Other clients never get it.
	h.hook("codex", "SessionStart", "c")
	if out := h.hook("codex", "UserPromptSubmit", "c"); out != nil {
		t.Fatalf("Codex prompt: %v", out)
	}
}

// The waiter outlives turns: the conversation's own events do not end its wait,
// which delivers nothing while the session works and wakes it once the turn ended.
func TestAntigravityWaitOutlivesTurns(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("antigravity", "SessionStart", "a")
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.untilStatus("antigravity:a", "listening")

	h.hook("antigravity", "UserPromptSubmit", "a")
	h.hook("antigravity", "PostToolUse", "a")
	eq(t, h.antigravityWaits("antigravity:a"), 1)
	eq(t, h.status("antigravity:a"), "working")
	h.send("s", "antigravity:a", "during the turn", false)
	time.Sleep(50 * time.Millisecond)
	eq(t, h.antigravityWaits("antigravity:a"), 1) // nothing delivered while working

	// Stop announces it itself; the wait does not repeat it, and wakes for what comes later.
	contains(t, h.hook("antigravity", "Stop", "a", stopInactive).str("reason"), "during the turn")
	if out := h.hook("antigravity", "Stop", "a", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("antigravity:a"), "listening")
	h.send("s", "antigravity:a", "after the turn", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), "after the turn")
	notContains(t, out.str("wake"), "during the turn")
	eq(t, h.status("antigravity:a"), "working")
}

// Of two waiters of one conversation, one delivers a wake; the other stays a standby.
func TestAntigravityTwoWaitersDeliverOnce(t *testing.T) {
	h := start(t, listenWait(time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("antigravity", "SessionStart", "a")
	first := h.openHook("antigravity", texts0BackgroundWait(), "a")
	second := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.until("two waits", func() bool { return h.antigravityWaits("antigravity:a") == 2 })
	h.send("s", "antigravity:a", "once", false)
	a, b := first.wait(t), second.wait(t)
	wakes := 0
	for _, out := range []hookOutput{a, b} {
		if out.str("wake") != "" {
			wakes++
			contains(t, out.str("wake"), "once")
		} else if out["timeout"] != true {
			t.Fatalf("standby: %v", out)
		}
	}
	eq(t, wakes, 1)
}

// A failed send is delivered again by the next wait; a report that a real event overtook changes nothing.
func TestAntigravityWakeResults(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("antigravity", "SessionStart", "a")
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.untilStatus("antigravity:a", "listening")
	h.send("s", "antigravity:a", "first", false)
	wake := waiting.wait(t)
	if out := h.hook("antigravity", testContract.Hook.WakeResultEvent, "a", wakeResult(wake.str("dispatchId"), false)); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("antigravity:a"), "idle")
	again := h.openHook("antigravity", texts0BackgroundWait(), "a").wait(t)
	contains(t, again.str("wake"), "first")

	// The woken turn's own event comes before the report: the report changes nothing.
	h.hook("antigravity", "UserPromptSubmit", "a")
	h.hook("antigravity", testContract.Hook.WakeResultEvent, "a", wakeResult(again.str("dispatchId"), false))
	eq(t, h.status("antigravity:a"), "working")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'antigravity:a' AND notified_at IS NULL"), 0)
}

// The automatic-turn limit holds for Antigravity wakes as for the others.
func TestAntigravityAutoTurnLimit(t *testing.T) {
	h := start(t, listenWait(300*time.Millisecond), maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("antigravity", "SessionStart", "a")
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.untilStatus("antigravity:a", "listening")
	h.send("s", "antigravity:a", "one", false)
	contains(t, waiting.wait(t).str("wake"), "one")
	h.hook("antigravity", "UserPromptSubmit", "a") // the woken turn
	h.hook("antigravity", "Stop", "a", stopInactive)
	capped := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.send("s", "antigravity:a", "two", false)
	eq(t, capped.wait(t)["timeout"], any(true))
}

// What the expiry check of the conversation's own prompt finds reaches that prompt,
// not the waiter's open wait, which the prompt no longer ends.
func TestAntigravityOwnEventIsNotOvertakenByItsWaiter(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "b")
	h.hook("antigravity", "SessionStart", "a")
	eq(t, h.antigravity("a", "send", map[string]any{"to": "codex:b", "text": "never read"}).status, 200)
	h.hook("antigravity", "Stop", "a", stopInactive)
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.untilStatus("antigravity:a", "listening")
	h.at(ms(timing.MessageTtlMs) + time.Second)
	// The prompt is the first event to find the message expired.
	text := h.hook("antigravity", "UserPromptSubmit", "a").injected()
	contains(t, text, "expired unread")
	eq(t, h.antigravityWaits("antigravity:a"), 1)
	eq(t, h.status("antigravity:a"), "working")
	h.ag.mu.Lock()
	pending := h.ag.dispatches["antigravity:a"]
	h.ag.mu.Unlock()
	if pending != nil {
		t.Fatal("the waiter was handed a wake during the prompt")
	}
	waiting.cancel()
}

// A SessionStart while the waiter waits leaves the conversation listening.
func TestAntigravitySessionStartWithAWaiterIsListening(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("antigravity", "SessionStart", "a")
	waiting := h.openHook("antigravity", texts0BackgroundWait(), "a")
	h.untilStatus("antigravity:a", "listening")
	h.hook("antigravity", "SessionStart", "a")
	eq(t, h.status("antigravity:a"), "listening")
	waiting.cancel()
}
