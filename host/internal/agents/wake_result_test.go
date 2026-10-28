package agents

import (
	"testing"
	"time"
)

// wakeResult reports a delivery as the Codex background wait does after `codex queue`.
func wakeResult(dispatchID string, ok bool) map[string]any {
	return map[string]any{"dispatch_id": dispatchID, "ok": ok, "cwd": nil}
}

// wokenCodex starts codex:s and codex:r (idle) and returns
// the wake a background wait of r gets for a message from s and a notice.
func wokenCodex(t *testing.T, h *harness) hookOutput {
	t.Helper()
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	eq(t, h.status("codex:r"), "idle")
	waiting := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	// A notice stored without waking anyone: the message below wakes the wait with both.
	if _, err := h.ag.db().Exec("INSERT INTO agent_notices (session_id, text, created_at) VALUES ('codex:r', 'a notice for r', '2026-01-01T00:00:00.000Z')"); err != nil {
		t.Fatal(err)
	}
	h.send("s", "codex:r", "ping", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), "ping")
	contains(t, out.str("wake"), "a notice for r")
	if out.str("dispatchId") == "" {
		t.Fatalf("wake without dispatchId: %v", out)
	}
	eq(t, h.status("codex:r"), "working")
	eq(t, h.notifiedCount(), 2)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND status = 'read'"), 1) // shown whole in the wake
	return out
}

func (h *harness) notifiedCount() int {
	return h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NOT NULL") +
		h.count("SELECT COUNT(*) FROM agent_notices WHERE session_id = 'codex:r' AND notified_at IS NOT NULL")
}

func (h *harness) agentState(id string) (autoTurns int, woken, pending bool) {
	h.ag.mu.Lock()
	defer h.ag.mu.Unlock()
	_, woken = h.ag.wokenAt[id]
	return h.ag.autoTurns[id], woken, h.ag.dispatches[id] != nil
}

func TestWakeResultFailedUndoesTheWake(t *testing.T) {
	h := start(t, listenWait(5*time.Second), maxTurns(2))
	out := wokenCodex(t, h)
	contains(t, out.str("wake"), "Automatic turn 1 of 2")
	turns, woken, pending := h.agentState("codex:r")
	eq(t, turns, 1)
	eq(t, woken, true)
	eq(t, pending, true)
	before := h.session("codex:r").LastActiveAt

	h.at(time.Minute)
	if res := h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), false)); res != nil {
		t.Fatalf("WakeResult output: %v", res)
	}
	eq(t, h.status("codex:r"), "idle")
	eq(t, h.notifiedCount(), 0)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND status = 'unread' AND read_at IS NULL"), 1)
	turns, woken, pending = h.agentState("codex:r")
	eq(t, turns, 0)
	eq(t, woken, false)
	eq(t, pending, false)
	eq(t, h.session("codex:r").LastActiveAt, before) // a report, not activity

	// The next background wait delivers the same message and notice again, as the first automatic turn.
	again := h.openHook("codex", texts0BackgroundWait(), "r").wait(t)
	contains(t, again.str("wake"), "ping")
	contains(t, again.str("wake"), "a notice for r")
	contains(t, again.str("wake"), "Automatic turn 1 of 2")
}

func TestWakeResultFailedAfterRealEventChangesNothing(t *testing.T) {
	h := start(t, listenWait(5*time.Second), maxTurns(2))
	out := wokenCodex(t, h)
	h.hook("codex", "UserPromptSubmit", "r") // the woken turn started
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), false))
	eq(t, h.status("codex:r"), "working")
	eq(t, h.notifiedCount(), 2)
	turns, _, pending := h.agentState("codex:r")
	eq(t, turns, 1)
	eq(t, pending, false)
}

func TestWakeResultDelivered(t *testing.T) {
	h := start(t, listenWait(5*time.Second), maxTurns(2))
	out := wokenCodex(t, h)
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), true))
	_, _, pending := h.agentState("codex:r")
	eq(t, pending, false)
	// A later failure report for the same wake is ignored: it was settled.
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), false))
	eq(t, h.status("codex:r"), "working")
	eq(t, h.notifiedCount(), 2)
	turns, _, _ := h.agentState("codex:r")
	eq(t, turns, 1)
}

func TestWakeResultUnknownDispatchIgnored(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	out := wokenCodex(t, h)
	// A background wait held meanwhile (it does not deliver while the session is working).
	waiting := h.openHook("codex", texts0BackgroundWait(), "r")
	h.until("wait registered", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return len(h.ag.backgroundWaits["codex:r"]) == 1 })

	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult("not-this-one", false))
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult("", false))
	eq(t, h.status("codex:r"), "working")
	eq(t, h.notifiedCount(), 2)
	_, _, pending := h.agentState("codex:r")
	eq(t, pending, true)

	// The matching report undoes the wake, and the held wait (not cancelled by the reports) delivers it again.
	h.hook("codex", testContract.Hook.WakeResultEvent, "r", wakeResult(out.str("dispatchId"), false))
	redelivered := waiting.wait(t)
	contains(t, redelivered.str("wake"), "ping")
	contains(t, redelivered.str("wake"), "a notice for r")
	if redelivered.str("dispatchId") == out.str("dispatchId") {
		t.Fatal("a new wake reused the dispatchId")
	}
	eq(t, h.status("codex:r"), "working")
}
