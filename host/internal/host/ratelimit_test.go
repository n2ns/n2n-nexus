package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

// startLimited starts a host whose tool-call buckets hold burst calls and
// refill so slowly that no token comes back during a test.
func startLimited(t *testing.T, burst float64) (post func(path string, body map[string]any) int) {
	t.Helper()
	s := config.Defaults()
	s.Port, s.RateLimit, s.RateBurst = 0, 0.001, burst
	h, err := Start(Options{Version: "test", DataDir: t.TempDir(), Settings: s, Logger: NewLogger(io.Discard)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	base := fmt.Sprintf("http://%s", h.Addr)
	return func(path string, body map[string]any) int {
		raw, _ := json.Marshal(body)
		res, err := http.Post(base+path, "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
}

func listMeetings(instance string, caller map[string]any) map[string]any {
	return map[string]any{"tool": "list_meetings", "args": map[string]any{}, "instanceId": instance, "caller": caller}
}

// Conversations that share an adapter instance have a tool-call budget each.
func TestToolCallsAreLimitedPerConversation(t *testing.T) {
	const burst = 2
	post := startLimited(t, burst)
	// Claude: the PreToolUse hook binds the toolUseId to its conversation.
	for _, s := range []string{"a", "b"} {
		if got := post("/api/hook", map[string]any{"client": "claude", "input": map[string]any{"hook_event_name": "PreToolUse", "session_id": s, "tool_use_id": "tu-" + s, "cwd": "/tmp/x", "machine": map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": 0}}}); got != 200 {
			t.Fatalf("PreToolUse %s: %d", s, got)
		}
	}
	for _, c := range []struct {
		instance    string
		busy, other map[string]any
	}{
		{"mcp-shared-claude", map[string]any{"client": "claude", "toolUseId": "tu-a"}, map[string]any{"client": "claude", "toolUseId": "tu-b"}},
		{"mcp-shared-codex", map[string]any{"client": "codex", "sessionId": "x"}, map[string]any{"client": "codex", "sessionId": "y"}},
	} {
		for i := 0; i < burst; i++ {
			if got := post("/api/tools/call", listMeetings(c.instance, c.busy)); got != 200 {
				t.Fatalf("%v call %d within its burst: %d", c.busy, i, got)
			}
		}
		if got := post("/api/tools/call", listMeetings(c.instance, c.busy)); got != http.StatusTooManyRequests {
			t.Fatalf("%v over its burst: %d, want 429", c.busy, got)
		}
		if got := post("/api/tools/call", listMeetings(c.instance, c.other)); got != 200 {
			t.Fatalf("%v on the same instance after another conversation spent its burst: %d, want 200", c.other, got)
		}
	}
}

// Without the hooks no conversation is known: calls share the instance's budget.
func TestToolCallsWithoutAConversationAreLimitedPerInstance(t *testing.T) {
	const burst = 2
	post := startLimited(t, burst)
	for i := 0; i < burst; i++ {
		if got := post("/api/tools/call", listMeetings("mcp-shared", map[string]any{"client": "claude", "toolUseId": fmt.Sprint("unbound-", i)})); got != 200 {
			t.Fatalf("call %d within the burst: %d", i, got)
		}
	}
	if got := post("/api/tools/call", listMeetings("mcp-shared", map[string]any{"client": "claude", "toolUseId": "unbound-x"})); got != http.StatusTooManyRequests {
		t.Fatalf("unidentified call over the instance's burst: %d, want 429", got)
	}
	if got := post("/api/tools/call", listMeetings("mcp-shared", nil)); got != http.StatusTooManyRequests {
		t.Fatalf("call without a caller over the instance's burst: %d, want 429", got)
	}
	if got := post("/api/tools/call", listMeetings("mcp-other", nil)); got != 200 {
		t.Fatalf("another instance: %d, want 200", got)
	}
}
