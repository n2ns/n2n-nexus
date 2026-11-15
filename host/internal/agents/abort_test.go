package agents

import (
	"context"
	"testing"
	"time"
)

// abortedHook sends a hook event of codex:r while the coordinator is busy,
// drops its connection once the event waits for the coordinator, and lets the
// coordinator go on only after the server noticed the closed connection; it
// returns when the coordinator has answered the event.
func (h *harness) abortedHook(event string, extra ...map[string]any) {
	h.t.Helper()
	watch := &hookWatch{arrived: make(chan context.Context, 1), returned: make(chan struct{}, 1)}
	h.watch.Store(watch)
	defer h.watch.Store(nil)
	h.ag.mu.Lock() // the coordinator is busy
	held := h.openHook("codex", event, "r", extra...)
	serverSide, ok := receive(watch.arrived) // the event reached the coordinator, which is busy
	if ok {
		held.cancel()                      // client killed
		_, ok = receive(serverSide.Done()) // the server noticed the closed connection
	}
	h.ag.mu.Unlock()
	if !ok {
		h.t.Fatal("the event did not reach the coordinator, or the server did not notice its closed connection")
	}
	if _, ok := receive(watch.returned); !ok {
		h.t.Fatal("the coordinator did not answer the event")
	}
}

func receive[T any](c <-chan T) (T, bool) {
	select {
	case v := <-c:
		return v, true
	case <-time.After(10 * time.Second):
		var zero T
		return zero, false
	}
}

// A hook whose client is already gone when the coordinator gets to it ends
// without its first check: nothing is marked delivered that nobody received.
func TestAbortedBeforeFirstCheckListening(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.send("s", "codex:r", "pending", false)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NULL"), 1)

	h.abortedHook("Stop", stopActive) // continuing a stop: it waits for messages
	notified := h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NOT NULL")
	if notified != 0 {
		t.Errorf("message marked notified though nobody received the block output")
	}
}

func TestAbortedBeforeFirstCheckBackground(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	eq(t, h.status("codex:r"), "idle")
	h.send("s", "codex:r", "pending", false)

	h.abortedHook(testContract.Hook.BackgroundWaitEvent)
	notified := h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NOT NULL")
	if notified != 0 || h.status("codex:r") != "idle" {
		t.Errorf("wake delivered to a gone client: notified=%d status=%s", notified, h.status("codex:r"))
	}
}
