package agents

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

func (h *harness) identity(instance string, caller *api.Caller) (api.Identity, error) {
	h.t.Helper()
	return h.ag.Identity(api.Call{Ctx: context.Background(), InstanceID: instance, Caller: caller})
}

func TestIdentityResolvesClaudeAndCodexSessions(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "c1")
	h.hook("claude", "PreToolUse", "c1", map[string]any{"tool_use_id": "toolu_a", "tool_name": "mcp__n2n-nexus__send_message"})
	id, err := h.identity("mcp-1", &api.Caller{Client: "claude", ToolUseID: "toolu_a"})
	if err != nil {
		t.Fatal(err)
	}
	want := api.Identity{Kind: api.IdentitySession, ID: "claude:c1", Name: h.session("claude:c1").Name, Instance: "mcp-1"}
	if id != want {
		t.Fatalf("got %+v want %+v", id, want)
	}

	h.hook("codex", "SessionStart", "x1")
	id, err = h.identity("mcp-2", &api.Caller{Client: "codex", SessionID: "x1"})
	if err != nil || id.Kind != api.IdentitySession || id.ID != "codex:x1" || id.Name == "" || id.Instance != "mcp-2" {
		t.Fatalf("codex: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances WHERE instance_id IN ('mcp-1', 'mcp-2')"), 2)

	// Without an instance: the session, and nothing recorded.
	id, err = h.identity("", &api.Caller{Client: "codex", SessionID: "x1"})
	if err != nil || id.ID != "codex:x1" || id.Instance != api.UnknownInstance {
		t.Fatalf("no instance: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances"), 2)
}

func TestIdentityFallsBackToTheInstanceWithoutHooks(t *testing.T) {
	h := start(t)
	// A caller is sent without hooks too: an unknown session falls back while the instance never resolved one.
	for _, caller := range []*api.Caller{nil, {Client: "claude", ToolUseID: "toolu_none"}, {Client: "codex", SessionID: "nobody"}} {
		id, err := h.identity("mcp-plain", caller)
		want := api.Identity{Kind: api.IdentityInstance, ID: "mcp-plain", Instance: "mcp-plain"}
		if err != nil || id != want {
			t.Fatalf("%+v: got %+v %v", caller, id, err)
		}
	}
	id, err := h.identity("", nil)
	if err != nil || id.ID != api.UnknownInstance || id.Kind != api.IdentityInstance {
		t.Fatalf("anonymous: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances"), 0)
}

func TestIdentityFailsForAHookedInstanceThatCannotResolve(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "x1")
	if _, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "x1"}); err != nil {
		t.Fatal(err)
	}
	for _, caller := range []*api.Caller{nil, {Client: "claude", ToolUseID: "toolu_unbound"}, {Client: "codex", SessionID: "unknown"}} {
		_, err := h.identity("mcp-1", caller)
		var te *api.ToolError
		if !errors.As(err, &te) || te.Message != identityRetryError {
			t.Fatalf("%+v: got %v", caller, err)
		}
	}
	// Other instances are not affected.
	if id, err := h.identity("mcp-2", nil); err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("other instance: %+v %v", id, err)
	}
}

func TestIdentityLeavesExpiredBindings(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "c1")
	h.hook("claude", "PreToolUse", "c1", map[string]any{"tool_use_id": "toolu_old", "tool_name": "mcp__n2n-nexus__read_messages"})
	h.at(time.Duration(testContract.Hook.Timing.ToolUseBindingTtlMs+1) * time.Millisecond)
	id, err := h.identity("mcp-new", &api.Caller{Client: "claude", ToolUseID: "toolu_old"})
	if err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("expired binding: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings WHERE tool_use_id = 'toolu_old'"), 1)
	// Nor does it refresh the session.
	eq(t, h.session("claude:c1").LastActiveAt, h.ag.iso(h.t0))
}

func TestIdentityFallsBackOnceTheInstanceStopsResolving(t *testing.T) {
	h := start(t)
	stale := time.Duration(testContract.Hook.Timing.StaleSessionMs) * time.Millisecond
	h.hook("codex", "SessionStart", "x1")
	if _, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "x1"}); err != nil {
		t.Fatal(err)
	}
	// A later resolution keeps the instance hooked.
	h.at(stale / 2)
	if _, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "x1"}); err != nil {
		t.Fatal(err)
	}
	h.at(stale)
	var te *api.ToolError
	if _, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "gone"}); !errors.As(err, &te) {
		t.Fatalf("within the window: %v", err)
	}
	// Hooks removed: once the instance has resolved no session for the stale window, it acts as the instance again.
	h.at(stale/2 + stale + time.Millisecond)
	id, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "gone"})
	if err != nil || id.Kind != api.IdentityInstance || id.ID != "mcp-1" {
		t.Fatalf("after the window: %+v %v", id, err)
	}
}

func TestIdentityResolvesPiSessionsByProcess(t *testing.T) {
	h := start(t)
	// pi names its process in each event: a tool call from that process is the session the process reported last.
	h.hook("pi", "SessionStart", "p1", map[string]any{"client_pid": 4242})
	box := &api.CallerMachine{Hostname: "box", Platform: "linux"}
	id, err := h.identity("mcp-pi", &api.Caller{Client: "pi", ClientPIDs: []int{4242}, Machine: box})
	if err != nil {
		t.Fatal(err)
	}
	want := api.Identity{Kind: api.IdentitySession, ID: "pi:p1", Name: h.session("pi:p1").Name, Instance: "mcp-pi"}
	if id != want {
		t.Fatalf("got %+v want %+v", id, want)
	}
	// A new session in the same process takes the process over.
	h.hook("pi", "SessionStart", "p2", map[string]any{"client_pid": 4242})
	if id, err := h.identity("mcp-pi", &api.Caller{Client: "pi", ClientPIDs: []int{4242}, Machine: box}); err != nil || id.ID != "pi:p2" {
		t.Fatalf("after /new: %+v %v", id, err)
	}
	// An unknown process falls back to the instance, as the other clients do without a session.
	if id, err := h.identity("mcp-other", &api.Caller{Client: "pi", ClientPIDs: []int{9999}, Machine: box}); err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("unknown process: %+v %v", id, err)
	}
	// A hook without a process ID records no mapping.
	h.hook("pi", "UserPromptSubmit", "p3")
	eq(t, h.count("SELECT COUNT(*) FROM pi_client_pids"), 1)
}

func TestIdentityResolvesPiByAncestorsOnItsMachine(t *testing.T) {
	h := start(t)
	box := map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": 0}
	other := map[string]any{"hostname": "other", "platform": "linux", "environment": "", "utcOffset": 0}
	h.hook("pi", "SessionStart", "a", map[string]any{"client_pid": 5000, "machine": box})
	h.hook("pi", "SessionStart", "b", map[string]any{"client_pid": 5000, "machine": other})
	on := func(host string) *api.CallerMachine { return &api.CallerMachine{Hostname: host, Platform: "linux"} }
	// The adapter's parent is a shell npx started: the first known ancestor is the pi process.
	if id, err := h.identity("mcp-a", &api.Caller{Client: "pi", ClientPIDs: []int{7001, 7000, 5000}, Machine: on("box")}); err != nil || id.ID != "pi:a" {
		t.Fatalf("box: %+v %v", id, err)
	}
	if id, err := h.identity("mcp-b", &api.Caller{Client: "pi", ClientPIDs: []int{5000}, Machine: on("other")}); err != nil || id.ID != "pi:b" {
		t.Fatalf("other: %+v %v", id, err)
	}
	if id, err := h.identity("mcp-c", &api.Caller{Client: "pi", ClientPIDs: []int{5000}, Machine: on("third")}); err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("third: %+v %v", id, err)
	}
}
