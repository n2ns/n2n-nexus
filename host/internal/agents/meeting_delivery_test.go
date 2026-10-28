package agents

import (
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/core"
)

// startMeetingDelivery runs both sides of meeting notifications through HTTP.
func startMeetingDelivery(t *testing.T) *harness {
	h := start(t)
	c := core.New(core.Deps{Store: h.st, Clock: h.clk, Contract: testContract,
		Logger: h.opts.Logger, Identities: h.ag, Meetings: h.ag})
	c.Register(h.srv.Config.Handler.(*api.Server))
	for _, id := range []string{"a", "b"} {
		h.hook("codex", "SessionStart", id)
	}
	return h
}

func (h *harness) meetingTool(session, tool string, args map[string]any) map[string]any {
	h.t.Helper()
	r := h.codex(session, tool, args)
	if r.status != 200 {
		h.t.Fatalf("%s: %d %s", tool, r.status, r.error)
	}
	if r.result["refused"] == true {
		h.t.Fatalf("%s refused: %v", tool, r.result["message"])
	}
	return r.result
}

func TestFailedWakeRestoresAsyncMeetingNews(t *testing.T) {
	h := startMeetingDelivery(t)
	id := h.meetingTool("a", "start_meeting", map[string]any{"topic": "Async news"})["meetingId"].(string)
	h.meetingTool("b", "join_meeting", map[string]any{"meetingId": id, "mode": "async"})
	h.meetingTool("a", "send_message", map[string]any{"meetingId": id, "message": "news"})
	h.hook("codex", "Stop", "b", stopActive)
	h.send("a", "codex:b", "wake with news", false)
	out := h.openHook("codex", texts0BackgroundWait(), "b").wait(t)
	contains(t, out.str("wake"), "Async news")
	eq(t, h.wakes(id, "codex:b"), 0)

	h.hook("codex", testContract.Hook.WakeResultEvent, "b", wakeResult(out.str("dispatchId"), false))
	again := h.openHook("codex", texts0BackgroundWait(), "b").wait(t)
	contains(t, again.str("wake"), "wake with news")
	contains(t, again.str("wake"), "Async news")
	eq(t, h.wakes(id, "codex:b"), 0)
}

func TestLeftAuthorReceivesStanceWithoutWaking(t *testing.T) {
	for _, event := range []string{"Stop", texts0BackgroundWait()} {
		t.Run(event, func(t *testing.T) {
			h := startMeetingDelivery(t)
			id := h.meetingTool("a", "start_meeting", map[string]any{"topic": "Left meeting"})["meetingId"].(string)
			h.meetingTool("b", "join_meeting", map[string]any{"meetingId": id})
			proposal := h.meetingTool("a", "send_message", map[string]any{
				"meetingId": id, "message": "proposal", "category": "PROPOSAL",
			})["messageId"]
			h.meetingTool("a", "leave_meeting", map[string]any{"meetingId": id})
			h.hook("codex", "PostToolUse", "a")
			h.hook("codex", "Stop", "a", stopActive)
			h.meetingTool("b", "read_messages", map[string]any{"meetingId": id})
			h.meetingTool("b", "stance", map[string]any{
				"meetingId": id, "messageId": proposal, "stance": "endorse",
			})
			out := h.openHook("codex", event, "a").wait(t)
			if event == "Stop" {
				if out != nil {
					t.Fatalf("left author's Stop blocked: %v", out)
				}
			} else if out["timeout"] != true {
				t.Fatalf("left author woken: %v", out)
			}
			// The author still sees the stance when the user next prompts it.
			contains(t, h.hook("codex", "UserPromptSubmit", "a").context(), "endorsed draft")
		})
	}
}

// What a refused send attached is announced: the tool call's own hook does not repeat it.
func TestRefusedSendIsNotAnnouncedAgain(t *testing.T) {
	h := startMeetingDelivery(t)
	id := h.meetingTool("a", "start_meeting", map[string]any{"topic": "Refused"})["meetingId"].(string)
	h.meetingTool("b", "join_meeting", map[string]any{"meetingId": id})
	h.meetingTool("a", "send_message", map[string]any{"meetingId": id, "message": "news"})
	r := h.codex("b", "send_message", map[string]any{"meetingId": id, "message": "mine"})
	if r.result["refused"] != true {
		t.Fatalf("not refused: %v", r.result)
	}
	if out := h.hook("codex", "PostToolUse", "b"); out != nil {
		t.Fatalf("attached news repeated: %v", out)
	}
	h.meetingTool("a", "send_message", map[string]any{"meetingId": id, "message": "later"})
	ctx := h.hook("codex", "PostToolUse", "b").context()
	contains(t, ctx, "\nlater\n")
	notContains(t, ctx, "\nnews\n")
}
