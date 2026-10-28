package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

const listenMS = 300

var testContract = func() *protocol.Contract {
	c, err := protocol.Load()
	if err != nil {
		panic(err)
	}
	return c
}()

type harness struct {
	t      *testing.T
	dir    string
	clk    *clock.Settable
	st     *store.Store
	ag     *Agents
	srv    *httptest.Server
	t0     time.Time
	toolNo atomic.Int64
	opts   Options
	// machines: the machine a session reported in its last event, sent again with its later events.
	machines map[string]any
}

type hostOption func(*Options)

func listenWait(d time.Duration) hostOption { return func(o *Options) { o.ListenWait = d } }
func maxTurns(n int) hostOption             { return func(o *Options) { o.MaxAutoTurns = n } }

// start runs a host (database, api.Server with the agents registered) on a
// fresh data directory, with the clock pinned to t0.
func start(t *testing.T, opts ...hostOption) *harness {
	t.Helper()
	h := &harness{t: t, dir: t.TempDir(), clk: &clock.Settable{}, t0: time.UnixMilli(time.Now().UnixMilli()), machines: map[string]any{}}
	h.clk.Set(h.t0)
	h.opts = Options{Clock: h.clk, Contract: testContract, Logger: log.New(io.Discard, "", 0),
		ListenWait: listenMS * time.Millisecond, MaxAutoTurns: testContract.Hook.Limits.DefaultMaxAutoTurns, RetentionDays: 7}
	for _, o := range opts {
		o(&h.opts)
	}
	h.open()
	t.Cleanup(h.stop)
	return h
}

func (h *harness) open() {
	h.t.Helper()
	st, err := store.Open(h.dir)
	if err != nil {
		h.t.Fatal(err)
	}
	h.st = st
	o := h.opts
	o.Store = st
	ag, err := New(o)
	if err != nil {
		h.t.Fatal(err)
	}
	h.ag = ag
	srv := api.New(api.Options{Version: "test", Contract: testContract, Clock: h.clk, RateLimit: 10000, RateBurst: 10000, Logger: o.Logger})
	ag.Register(srv)
	h.srv = httptest.NewServer(srv)
}

func (h *harness) stop() {
	if h.srv == nil {
		return
	}
	h.ag.Close()
	h.srv.CloseClientConnections()
	h.srv.Close()
	h.st.Close()
	h.srv = nil
}

// restart stops the host and starts a new one on the same data directory.
func (h *harness) restart() {
	h.stop()
	h.open()
}

func (h *harness) at(d time.Duration) { h.clk.Set(h.t0.Add(d)) }

type hookOutput map[string]any

func (o hookOutput) context() string {
	hs, _ := o["hookSpecificOutput"].(map[string]any)
	s, _ := hs["additionalContext"].(string)
	return s
}
func (o hookOutput) str(key string) string { s, _ := o[key].(string); return s }

func (h *harness) post(ctx context.Context, path string, body any) (int, map[string]any, error) {
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.srv.URL+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return res.StatusCode, nil, fmt.Errorf("body %q: %w", data, err)
	}
	return res.StatusCode, payload, nil
}

// testMachine is where every test session runs unless a test says otherwise.
var testMachine = map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": float64(0)}

func hookInput(event, sessionID string, extra map[string]any) map[string]any {
	in := map[string]any{"hook_event_name": event, "session_id": sessionID, "cwd": "/work/proj", "machine": testMachine}
	for k, v := range extra {
		if v == nil {
			delete(in, k)
		} else {
			in[k] = v
		}
	}
	return in
}

// hook sends a hook event (cwd /work/proj unless extra overrides it; a nil value removes a field).
func (h *harness) hook(client, event, sessionID string, extra ...map[string]any) hookOutput {
	h.t.Helper()
	x := map[string]any{}
	if len(extra) > 0 {
		maps.Copy(x, extra[0])
	}
	// A session keeps reporting the machine it reported last, as a real client does.
	key := client + ":" + sessionID
	if m, ok := x["machine"]; ok {
		h.machines[key] = m
	} else if m, ok := h.machines[key]; ok {
		x["machine"] = m
	}
	status, payload, err := h.post(context.Background(), "/api/hook", map[string]any{"client": client, "input": hookInput(event, sessionID, x)})
	if err != nil || status != 200 {
		h.t.Fatalf("hook %s %s: %d %v %v", event, sessionID, status, payload, err)
	}
	out, _ := payload["output"].(map[string]any)
	if out == nil {
		return nil
	}
	return out
}

type held struct {
	cancel context.CancelFunc
	done   chan heldResult
}

type heldResult struct {
	status  int
	payload map[string]any
	err     error
}

// openHook sends a hook event in the background; cancel drops the connection like a killed hook.
func (h *harness) openHook(client, event, sessionID string, extra ...map[string]any) *held {
	var x map[string]any
	if len(extra) > 0 {
		x = extra[0]
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &held{cancel: cancel, done: make(chan heldResult, 1)}
	body := map[string]any{"client": client, "input": hookInput(event, sessionID, x)}
	go func() {
		status, payload, err := h.post(ctx, "/api/hook", body)
		r.done <- heldResult{status, payload, err}
	}()
	return r
}

func (r *held) wait(t *testing.T) hookOutput {
	t.Helper()
	select {
	case res := <-r.done:
		if res.err != nil || res.status != 200 {
			t.Fatalf("held hook: %d %v %v", res.status, res.payload, res.err)
		}
		if _, ok := res.payload["output"]; !ok {
			t.Fatalf("held hook: no output in %v", res.payload)
		}
		out, _ := res.payload["output"].(map[string]any)
		if out == nil {
			return nil
		}
		return out
	case <-time.After(10 * time.Second):
		t.Fatal("held hook did not answer")
		return nil
	}
}

type toolReply struct {
	status int
	result map[string]any
	error  string
}

func (h *harness) call(caller any, tool string, args map[string]any) toolReply {
	h.t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	body := map[string]any{"tool": tool, "args": args, "instanceId": "i"}
	if caller != nil {
		body["caller"] = caller
	}
	status, payload, err := h.post(context.Background(), "/api/tools/call", body)
	if err != nil {
		h.t.Fatal(err)
	}
	r := toolReply{status: status}
	r.result, _ = payload["result"].(map[string]any)
	r.error, _ = payload["error"].(string)
	return r
}

func (h *harness) codex(sessionID, tool string, args map[string]any) toolReply {
	h.t.Helper()
	return h.call(map[string]any{"client": "codex", "sessionId": sessionID}, tool, args)
}

// claude calls a tool as a Claude session: PreToolUse binds a fresh toolUseId first.
func (h *harness) claude(sessionID, tool string, args map[string]any) toolReply {
	h.t.Helper()
	id := fmt.Sprintf("toolu_%d", h.toolNo.Add(1))
	if out := h.hook("claude", "PreToolUse", sessionID, map[string]any{"tool_use_id": id, "tool_name": "mcp__n2n-nexus__" + tool}); out != nil {
		h.t.Fatalf("PreToolUse printed %v", out)
	}
	return h.call(map[string]any{"client": "claude", "toolUseId": id}, tool, args)
}

func (h *harness) send(from, to, text string, notifyWhenIdle bool) string {
	h.t.Helper()
	r := h.codex(from, "send", map[string]any{"to": to, "text": text, "notifyWhenIdle": notifyWhenIdle})
	if r.status != 200 {
		h.t.Fatalf("send: %d %s", r.status, r.error)
	}
	return r.result["messageId"].(string)
}

func (h *harness) session(id string) *session {
	h.t.Helper()
	s, err := getSession(h.st.DB, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return s
}

func (h *harness) status(id string) string {
	h.t.Helper()
	if s := h.session(id); s != nil {
		return s.Status
	}
	return ""
}

func (h *harness) count(query string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.st.DB.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func (h *harness) until(what string, pred func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !pred() {
		if time.Now().After(deadline) {
			h.t.Fatalf("condition not reached: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) untilStatus(id, status string) {
	h.t.Helper()
	h.until(id+" "+status, func() bool { return h.status(id) == status })
}

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func contains(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Fatalf("%q does not contain %q", s, sub)
	}
}

func notContains(t *testing.T, s, sub string) {
	t.Helper()
	if strings.Contains(s, sub) {
		t.Fatalf("%q contains %q", s, sub)
	}
}

var (
	texts  = testContract.Hook.Texts
	timing = testContract.Hook.Timing
	prefix = texts.NoticePrefix
)
