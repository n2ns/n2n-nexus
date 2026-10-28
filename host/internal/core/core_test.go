package core

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

var start = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

type harness struct {
	t     *testing.T
	core  *Core
	srv   *api.Server
	store *store.Store
	clock *clock.Settable
	http  *httptest.Server
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWith(t, nil)
}

// newHarnessWith runs the core tools with an identity resolver (nil = every call acts as its instance).
// newHarnessWith: a harness whose calls are resolved by ids and, when given, whose meeting changes go to meetings.
func newHarnessWith(t *testing.T, ids api.IdentityResolver, meetings ...api.MeetingNotifier) *harness {
	t.Helper()
	contract, err := protocol.Load()
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	clk := &clock.Settable{}
	clk.Set(start)
	logger := log.New(io.Discard, "", 0)
	srv := api.New(api.Options{Version: "test", Contract: contract, Clock: clk, Logger: logger})
	d := Deps{Store: st, Clock: clk, Contract: contract, Logger: logger, Identities: ids, MeetingRetentionDays: 30, RetentionDays: 7}
	if len(meetings) > 0 {
		d.Meetings = meetings[0]
	}
	c := New(d)
	c.Register(srv)
	h := &harness{t: t, core: c, srv: srv, store: st, clock: clk, http: httptest.NewServer(srv)}
	t.Cleanup(func() {
		h.http.Close()
		st.Close()
	})
	return h
}

type response struct {
	status int
	result json.RawMessage
	err    string
}

// call posts a tool call; instance "" sends no instanceId.
func (h *harness) call(tool string, args any, instance string) response {
	h.t.Helper()
	return h.callAs(tool, args, instance, nil)
}

// callAs posts a tool call with a caller (nil sends none).
func (h *harness) callAs(tool string, args any, instance string, caller *api.Caller) response {
	h.t.Helper()
	body := map[string]any{"tool": tool, "args": args}
	if instance != "" {
		body["instanceId"] = instance
	}
	if caller != nil {
		body["caller"] = caller
	}
	raw, _ := json.Marshal(body)
	res, err := http.Post(h.http.URL+"/api/tools/call", "application/json", bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		h.t.Fatal(err)
	}
	return response{status: res.StatusCode, result: out.Result, err: out.Error}
}

// ok calls a tool that must succeed, and not be refused for unread messages,
// and decodes its result into a generic value.
func (h *harness) ok(tool string, args any, instance string) map[string]any {
	h.t.Helper()
	r := h.call(tool, args, instance)
	if r.status != 200 {
		h.t.Fatalf("%s: status %d: %s", tool, r.status, r.err)
	}
	var v map[string]any
	if err := json.Unmarshal(r.result, &v); err != nil {
		h.t.Fatal(err)
	}
	if v["refused"] == true {
		h.t.Fatalf("%s refused: %v", tool, v["message"])
	}
	return v
}

// refusedAs calls a tool as a Codex session; it must be refused for unread messages.
func (h *harness) refusedAs(session, tool string, args map[string]any) map[string]any {
	h.t.Helper()
	r := h.callAs(tool, args, "mcp-1", codex(session))
	var v map[string]any
	if err := json.Unmarshal(r.result, &v); err != nil || r.status != 200 || v["refused"] != true || v["ok"] != false {
		h.t.Fatalf("%s as %s: not refused: %d %s %s", tool, session, r.status, r.result, r.err)
	}
	return v
}

// catchUp reads a meeting's unread messages as an instance.
func (h *harness) catchUp(meetingID, instance string) {
	h.t.Helper()
	h.ok("read_messages", map[string]any{"meetingId": meetingID, "count": 100}, instance)
}

// catchUpAs reads a meeting's unread messages as a Codex session.
func (h *harness) catchUpAs(session, meetingID string) {
	h.t.Helper()
	h.as(session, "read_messages", map[string]any{"meetingId": meetingID, "count": 100})
}

// fails calls a tool that must fail with status and an error containing want.
func (h *harness) fails(status int, want, tool string, args any, instance string) {
	h.t.Helper()
	r := h.call(tool, args, instance)
	if r.status != status || !strings.Contains(r.err, want) {
		h.t.Fatalf("%s: got %d %q, want %d containing %q", tool, r.status, r.err, status, want)
	}
}

// count runs a COUNT query directly on the database.
func (h *harness) count(query string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.store.DB.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func (h *harness) exec(query string, args ...any) {
	h.t.Helper()
	if _, err := h.store.DB.Exec(query, args...); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) eventActions(prefix string) []string {
	h.t.Helper()
	args := map[string]any{"limit": 500}
	if prefix != "" {
		args["action"] = prefix
	}
	var actions []string
	for _, e := range h.ok("list_events", args, "")["events"].([]any) {
		actions = append(actions, e.(map[string]any)["action"].(string))
	}
	return actions
}

func TestRegistersEveryCoreTool(t *testing.T) {
	h := newHarness(t)
	missing := h.srv.Missing()
	slices.Sort(missing)
	// What is left belongs to internal/agents.
	if want := []string{"listen", "peers", "read", "reply", "send", "set_profile"}; !slices.Equal(missing, want) {
		t.Fatalf("tools without a handler: %v, want %v", missing, want)
	}
}

func TestMaintainExpiresAndPurges(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if line, err := h.core.Maintain(ctx); err != nil || line != "" {
		t.Fatalf("nothing to do: %q %v", line, err)
	}

	// TTL boundary to the millisecond: created at .900, ttl 1000 expires only after +1001 ms.
	h.clock.Set(start.Add(900 * time.Millisecond))
	overdue := h.ok("create_task", map[string]any{"ttl": 1000}, "")["task_id"].(string)
	fresh := h.ok("create_task", map[string]any{"ttl": 30 * 24 * 3600_000}, "")["task_id"].(string)
	noTTL := h.ok("create_task", map[string]any{}, "")["task_id"].(string)
	for _, elapsed := range []time.Duration{200, 999, 1000} {
		h.clock.Set(start.Add(900*time.Millisecond + elapsed*time.Millisecond))
		if line, _ := h.core.Maintain(ctx); line != "" {
			t.Fatalf("expired at +%d ms: %s", elapsed, line)
		}
	}
	h.clock.Set(start.Add(1901 * time.Millisecond))
	line, err := h.core.Maintain(ctx)
	if err != nil {
		t.Fatalf("got %q %v", line, err)
	}
	if line != "cleanup: 1 tasksExpired" {
		t.Fatalf("got %q", line)
	}
	task := h.ok("get_task", map[string]any{"taskId": overdue}, "")
	if task["status"] != "failed" || task["error_message"] != "TTL expired" {
		t.Fatalf("overdue task: %v", task)
	}
	for _, id := range []string{fresh, noTTL} {
		if s := h.ok("get_task", map[string]any{"taskId": id}, "")["status"]; s != "pending" {
			t.Fatalf("%s: %v", id, s)
		}
	}

	// Finished tasks and events go retentionDays (7) after their last update;
	// the cleanup that removed them is recorded.
	h.clock.Set(start.Add(3 * 24 * time.Hour))
	h.ok("sync_global_doc", map[string]any{"docId": "d", "title": "t", "content": "c"}, "a")
	h.clock.Set(start.Add(7*24*time.Hour + 1901*time.Millisecond))
	if line, _ := h.core.Maintain(ctx); line != "" {
		t.Fatalf("at the boundary: %q", line)
	}
	h.clock.Set(start.Add(7*24*time.Hour + 1902*time.Millisecond))
	// The event is the cleanup that expired the task.
	if line, _ := h.core.Maintain(ctx); line != "cleanup: 1 tasks, 1 events" {
		t.Fatalf("got %q", line)
	}
	h.fails(400, "not found", "get_task", map[string]any{"taskId": overdue}, "")
	if n := h.count(`SELECT COUNT(*) FROM tasks`); n != 2 {
		t.Fatalf("%d tasks left", n)
	}
	h.clock.Set(start.Add(10*24*time.Hour + time.Hour))
	if line, _ := h.core.Maintain(ctx); line != "cleanup: 1 events" {
		t.Fatalf("got %q", line)
	}
	if got := h.eventActions(""); !slices.Equal(got, []string{"maintenance.cleanup", "maintenance.cleanup"}) {
		t.Fatalf("events left: %v", got)
	}
}
