package api

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
)

// Hooks are limited per session and per address in buckets of their own: tool calls that used up their address budget do not block them.
func TestHooksDoNotShareTheAddressBucket(t *testing.T) {
	contract, err := protocol.Load()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Options{Version: "test", Contract: contract, Clock: clock.System{}, RateLimit: 0.01, RateBurst: 1, Logger: log.New(io.Discard, "", 0)})
	srv.Register("get_task", func(Call) (any, error) { return nil, Errorf("no task") })
	ts := httptest.NewServer(srv)
	defer ts.Close()
	post := func(path, body string) int {
		res, err := http.Post(ts.URL+path, "application/json", bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for i := 0; i < AddressLimitFactor+1; i++ {
		post("/api/tools/call", `{"tool":"get_task","args":{"taskId":"x"},"instanceId":"i`+string(rune('a'+i))+`"}`)
	}
	if got := post("/api/tools/call", `{"tool":"get_task","args":{"taskId":"x"},"instanceId":"z"}`); got != http.StatusTooManyRequests {
		t.Fatalf("address budget not used up: %d", got)
	}
	if got := post("/api/hook", `{"client":"codex","input":{"hook_event_name":"Stop","session_id":"s"}}`); got != http.StatusOK {
		t.Fatalf("hook after tool calls used the address budget: %d, want 200", got)
	}
	if got := post("/api/hook", `{"client":"codex","input":{"hook_event_name":"Stop","session_id":"s"}}`); got != http.StatusTooManyRequests {
		t.Fatalf("second hook of the session within its budget: %d, want 429", got)
	}
}
