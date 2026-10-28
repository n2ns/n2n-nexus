package core

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

func (h *harness) texts(args map[string]any, instance string) []string {
	h.t.Helper()
	res := h.ok("read_messages", args, instance)
	texts := []string{}
	for _, m := range res["messages"].([]any) {
		texts = append(texts, m.(map[string]any)["text"].(string))
	}
	if int(res["count"].(float64)) != len(texts) {
		h.t.Fatalf("count %v for %d messages", res["count"], len(texts))
	}
	return texts
}

func TestGlobalChatCursorsPerInstance(t *testing.T) {
	h := newHarness(t)
	res := h.ok("send_message", map[string]any{"message": "one", "category": "UPDATE"}, "A")
	if res["sentTo"] != "global" || res["messageId"] != 1.0 {
		t.Fatalf("send: %v", res)
	}
	h.ok("send_message", map[string]any{"message": "two"}, "")

	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"one", "two"}) {
		t.Fatalf("first read %v", got)
	}
	if got := h.texts(map[string]any{}, "reader"); len(got) != 0 {
		t.Fatalf("second read %v", got)
	}
	if got := h.texts(map[string]any{}, "other"); len(got) != 2 {
		t.Fatalf("other reader %v", got)
	}
	h.ok("send_message", map[string]any{"message": "three"}, "A")
	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"three"}) {
		t.Fatalf("after new message %v", got)
	}

	// count limits a batch without skipping messages.
	for i := range 5 {
		h.ok("send_message", map[string]any{"message": fmt.Sprintf("m%d", i)}, "A")
	}
	for _, want := range [][]string{{"m0", "m1"}, {"m2", "m3"}, {"m4"}} {
		if got := h.texts(map[string]any{"count": 2}, "reader"); !slices.Equal(got, want) {
			t.Fatalf("got %v want %v", got, want)
		}
	}

	// A message without a category has category null; the sender is "unknown" without an instance.
	r := h.call("read_messages", map[string]any{"count": 2}, "fresh")
	var raw struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	json.Unmarshal(r.result, &raw)
	if string(raw.Messages[0]["category"]) != `"UPDATE"` || string(raw.Messages[1]["category"]) != "null" || string(raw.Messages[1]["from"]) != `"unknown"` {
		t.Fatalf("messages %s", r.result)
	}
}

func TestReadMessagesNeedsAnInstance(t *testing.T) {
	h := newHarness(t)
	h.ok("send_message", map[string]any{"message": "x"}, "A")
	h.fails(400, "read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically) to keep unread cursors; history reads (latest or afterId) need none.", "read_messages", map[string]any{}, "")
	id := h.ok("start_meeting", map[string]any{"topic": "t"}, "A")["meetingId"]
	h.fails(400, "read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically) to keep unread cursors; history reads (latest or afterId) need none.", "read_messages", map[string]any{"meetingId": id}, "")
	if n := h.count(`SELECT COUNT(*) FROM read_cursors`); n != 0 {
		t.Fatalf("%d cursors", n)
	}
	// History reads need no instance.
	if got := h.texts(map[string]any{"latest": true}, ""); !slices.Equal(got, []string{"x"}) {
		t.Fatalf("history %v", got)
	}
}

func TestValidationErrorListsOnlyTheFailures(t *testing.T) {
	h := newHarness(t)
	r := h.call("read_messages", map[string]any{"count": "x"}, "i")
	if want := "Invalid arguments for read_messages: at '/count': got string, want integer"; r.status != 400 || r.err != want {
		t.Fatalf("got %d %q, want %q", r.status, r.err, want)
	}
	// Several failures, in any order, joined with "; ".
	r = h.call("read_messages", map[string]any{"count": "x", "meetingId": 3}, "i")
	got := strings.TrimPrefix(r.err, "Invalid arguments for read_messages: ")
	parts := strings.Split(got, "; ")
	slices.Sort(parts)
	if want := []string{"at '/count': got string, want integer", "at '/meetingId': got number, want string"}; r.status != 400 || !slices.Equal(parts, want) {
		t.Fatalf("got %d %q", r.status, r.err)
	}
}

func TestHostMaintenance(t *testing.T) {
	h := newHarness(t)
	for i := range 3 {
		h.ok("send_message", map[string]any{"message": fmt.Sprintf("m%d", i)}, "A")
	}
	h.texts(map[string]any{}, "reader")

	res := h.ok("host_maintenance", map[string]any{"action": "prune", "count": 1}, "ops")
	if res["removed"] != 1.0 || res["remaining"] != 2.0 || res["message"] != "Removed 1 global messages." {
		t.Fatalf("prune %v", res)
	}
	for _, args := range []map[string]any{{"action": "prune"}, {"action": "prune", "count": 0}} {
		h.fails(400, `host_maintenance prune needs count ≥ 1 (the number of oldest global messages to remove); use action "clear" to remove all.`, "host_maintenance", args, "ops")
	}
	if res := h.ok("host_maintenance", map[string]any{"action": "clear"}, "ops"); res["removed"] != 2.0 || res["remaining"] != 0.0 {
		t.Fatalf("clear %v", res)
	}
	// Ids are not reused: a reader's cursor still sees new messages.
	h.ok("send_message", map[string]any{"message": "new"}, "A")
	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"new"}) {
		t.Fatalf("after clear %v", got)
	}
	ev := h.ok("list_events", map[string]any{"action": "maintenance"}, "")["events"].([]any)
	first := ev[0].(map[string]any)
	if len(ev) != 2 || first["action"] != "maintenance.clear" || first["actor"] != "ops" ||
		!reflect.DeepEqual(first["detail"], map[string]any{"removed": 2.0}) {
		t.Fatalf("events %v", ev)
	}
	if _, ok := first["target"]; ok {
		t.Fatal("maintenance event has a target")
	}
}

func TestListEventsFilter(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("web_x", "X", ""))
	h.ok("update_global_strategy", map[string]any{"content": "s"}, "")
	h.ok("rename_project", map[string]any{"oldId": "web_x", "newId": "web_y"}, "ide-b")
	for _, tc := range []struct {
		action string
		want   []string
	}{
		{"", []string{"project.rename", "strategy.update", "project.sync"}},
		{"project", []string{"project.rename", "project.sync"}},
		{"project.sync", []string{"project.sync"}},
		{"Project", nil},
		{"%", nil},
		{"proj_ct", nil},
		{"project.", nil},
		{"strategy", []string{"strategy.update"}},
	} {
		if got := h.eventActions(tc.action); !slices.Equal(got, tc.want) {
			t.Errorf("%q: got %v want %v", tc.action, got, tc.want)
		}
	}
	if res := h.ok("list_events", map[string]any{"limit": 1}, ""); res["count"] != 1.0 {
		t.Fatalf("limit %v", res)
	}
	// strategy.update has neither target nor detail.
	r := h.call("list_events", map[string]any{"action": "strategy"}, "")
	var raw struct {
		Events []map[string]json.RawMessage `json:"events"`
	}
	json.Unmarshal(r.result, &raw)
	if _, ok := raw.Events[0]["target"]; ok {
		t.Fatalf("target present: %s", r.result)
	}
	if _, ok := raw.Events[0]["detail"]; ok {
		t.Fatalf("detail present: %s", r.result)
	}
	if string(raw.Events[0]["actor"]) != `"unknown"` {
		t.Fatalf("actor %s", raw.Events[0]["actor"])
	}
}

func TestStrategyAndGlobalDocs(t *testing.T) {
	h := newHarness(t)
	if got := h.ok("get_global_strategy", map[string]any{}, "")["content"]; got != "# Global Coordination Blueprint\n\nShared meeting space." {
		t.Fatalf("fresh strategy %q", got)
	}
	h.ok("update_global_strategy", map[string]any{"content": "# Strategy"}, "ide-a")
	if got := h.ok("get_global_strategy", map[string]any{}, "")["content"]; got != "# Strategy" {
		t.Fatalf("strategy %q", got)
	}
	h.fails(400, "Invalid arguments", "get_global_strategy", map[string]any{"extra": 1}, "")

	h.ok("sync_global_doc", map[string]any{"docId": "protocol", "title": "Sync Protocol", "content": "# v1"}, "ide-a")
	h.ok("sync_global_doc", map[string]any{"docId": "same-time", "title": "Same", "content": "x"}, "")
	h.clock.Set(start.Add(1e9))
	h.ok("sync_global_doc", map[string]any{"docId": "glossary", "title": "Glossary", "content": "# terms"}, "ide-b")

	list := h.ok("list_global_docs", map[string]any{}, "")
	var ids []string
	for _, d := range list["docs"].([]any) {
		ids = append(ids, d.(map[string]any)["docId"].(string))
	}
	if !slices.Equal(ids, []string{"glossary", "protocol", "same-time"}) || list["count"] != 3.0 {
		t.Fatalf("list %v", list)
	}
	doc := h.ok("get_global_doc", map[string]any{"docId": "protocol"}, "")
	want := map[string]any{"docId": "protocol", "title": "Sync Protocol", "content": "# v1", "updatedBy": "ide-a", "lastUpdated": "2026-10-23T12:00:00.000Z"}
	if !reflect.DeepEqual(doc, want) {
		t.Fatalf("doc %v", doc)
	}
	if got := h.ok("get_global_doc", map[string]any{"docId": "same-time"}, "")["updatedBy"]; got != "unknown" {
		t.Fatalf("updatedBy %v", got)
	}
	// Re-syncing replaces title, content and author.
	h.ok("sync_global_doc", map[string]any{"docId": "protocol", "title": "P2", "content": "# v2"}, "ide-c")
	if doc := h.ok("get_global_doc", map[string]any{"docId": "protocol"}, ""); doc["title"] != "P2" || doc["content"] != "# v2" || doc["updatedBy"] != "ide-c" {
		t.Fatalf("resynced %v", doc)
	}
	h.fails(400, "Document 'nope' not found.", "get_global_doc", map[string]any{"docId": "nope"}, "")
	if got := h.eventActions("doc"); len(got) != 4 {
		t.Fatalf("doc events %v", got)
	}
}

// fakeIdentities: a Codex caller acts as session codex:<sessionId>, except
// session "lost", whose resolution fails as for a hooked instance; any other
// call acts as its instance.
type fakeIdentities struct{}

func (fakeIdentities) Identity(c api.Call) (api.Identity, error) {
	if c.Caller != nil && c.Caller.SessionID != "" {
		if c.Caller.SessionID == "lost" {
			return api.Identity{}, api.Errorf("session cannot be resolved; retry")
		}
		return api.Identity{Kind: api.IdentitySession, ID: "codex:" + c.Caller.SessionID, Name: c.Caller.SessionID, Instance: c.Actor()}, nil
	}
	return api.Identity{Kind: api.IdentityInstance, ID: c.Actor(), Instance: c.Actor()}, nil
}

func codex(session string) *api.Caller { return &api.Caller{Client: "codex", SessionID: session} }

// as calls a tool as a Codex session through the shared instance "mcp-1"; it must succeed.
func (h *harness) as(session, tool string, args map[string]any) map[string]any {
	h.t.Helper()
	r := h.callAs(tool, args, "mcp-1", codex(session))
	if r.status != 200 {
		h.t.Fatalf("%s as %s: status %d: %s", tool, session, r.status, r.err)
	}
	var v map[string]any
	if err := json.Unmarshal(r.result, &v); err != nil {
		h.t.Fatal(err)
	}
	return v
}

func messageTexts(res map[string]any) []string {
	texts := []string{}
	for _, m := range res["messages"].([]any) {
		texts = append(texts, m.(map[string]any)["text"].(string))
	}
	return texts
}

func TestGlobalChatPerSession(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.exec(`INSERT INTO agent_sessions (id, client, name, cwd, status, created_at, last_active_at, hostname, platform, utc_offset) VALUES ('codex:a', 'codex', 'alice', '/w', 'idle', 'x', 'x', 'box', 'linux', 0)`)
	h.ok("send_message", map[string]any{"message": "old"}, "mcp-0")

	// A session's first read starts at the newest message, with a note.
	res := h.as("b", "read_messages", map[string]any{})
	if len(messageTexts(res)) != 0 || res["note"] != firstGlobalReadNote || res["identity"] != "session" || res["mode"] != "unread" {
		t.Fatalf("first read %v", res)
	}
	sent := h.as("a", "send_message", map[string]any{"message": "from a"})
	if sent["sentTo"] != "global" || sent["identity"] != "session" {
		t.Fatalf("send %v", sent)
	}
	h.ok("send_message", map[string]any{"message": "from instance"}, "mcp-0")
	res = h.as("b", "read_messages", map[string]any{})
	if got := messageTexts(res); !slices.Equal(got, []string{"from a", "from instance"}) || res["note"] != nil {
		t.Fatalf("second read %v", res)
	}
	msgs := res["messages"].([]any)
	if m := msgs[0].(map[string]any); m["from"] != "codex:a" || m["senderName"] != "alice" {
		t.Fatalf("session message %v", m)
	}
	if m := msgs[1].(map[string]any); m["from"] != "mcp-0" || m["senderName"] != nil {
		t.Fatalf("instance message %v", m)
	}
	// Another session on the same instance has its own cursor; a session without an agent_sessions row has no name.
	if res := h.as("c", "read_messages", map[string]any{}); len(messageTexts(res)) != 0 || res["note"] != firstGlobalReadNote {
		t.Fatalf("c first read %v", res)
	}
	h.as("b", "send_message", map[string]any{"message": "from b"})
	res = h.as("c", "read_messages", map[string]any{})
	if m := res["messages"].([]any)[0].(map[string]any); m["from"] != "codex:b" || m["senderName"] != nil {
		t.Fatalf("unnamed session message %v", m)
	}
	// The instance itself reads from the start.
	if got := h.texts(map[string]any{}, "mcp-1"); !slices.Equal(got, []string{"old", "from a", "from instance", "from b"}) {
		t.Fatalf("instance read %v", got)
	}
}

func TestUnreadLeavesOutOwnMessages(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.as("a", "read_messages", map[string]any{}) // start counting
	for _, m := range [][2]string{{"a", "a1"}, {"a", "a2"}, {"b", "b1"}, {"a", "a3"}, {"b", "b2"}, {"a", "a4"}} {
		h.as(m[0], "send_message", map[string]any{"message": m[1]})
	}
	if got := messageTexts(h.as("a", "read_messages", map[string]any{"count": 1})); !slices.Equal(got, []string{"b1"}) {
		t.Fatalf("first %v", got)
	}
	// Only the caller's own messages are left after b2: the cursor moves past them.
	if got := messageTexts(h.as("a", "read_messages", map[string]any{})); !slices.Equal(got, []string{"b2"}) {
		t.Fatalf("second %v", got)
	}
	if n := h.count(`SELECT last_read_id FROM read_cursors WHERE instance_id = 'codex:a' AND context_type = 'global'`); n != h.count(`SELECT MAX(id) FROM global_messages`) {
		t.Fatalf("cursor %d", n)
	}
	h.as("a", "send_message", map[string]any{"message": "a5"})
	if got := messageTexts(h.as("a", "read_messages", map[string]any{})); len(got) != 0 {
		t.Fatalf("own message read %v", got)
	}
	// An instance leaves out its own messages too.
	h.ok("send_message", map[string]any{"message": "i1"}, "mcp-9")
	if got := h.texts(map[string]any{}, "mcp-9"); slices.Contains(got, "i1") {
		t.Fatalf("instance own message %v", got)
	}
}

func TestReadMessagesHistory(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.as("a", "read_messages", map[string]any{})
	for i := range 5 {
		h.as("a", "send_message", map[string]any{"message": fmt.Sprintf("m%d", i)})
	}
	// History includes the caller's own messages.
	res := h.as("a", "read_messages", map[string]any{"latest": true, "count": 2})
	if got := messageTexts(res); !slices.Equal(got, []string{"m3", "m4"}) || res["mode"] != "history" || res["identity"] != nil {
		t.Fatalf("latest %v", res)
	}
	first := int(res["messages"].([]any)[0].(map[string]any)["id"].(float64))
	if got := messageTexts(h.as("a", "read_messages", map[string]any{"afterId": first - 2, "count": 2})); !slices.Equal(got, []string{"m2", "m3"}) {
		t.Fatalf("afterId %v", got)
	}
	if got := messageTexts(h.as("a", "read_messages", map[string]any{"afterId": 0})); len(got) != 5 {
		t.Fatalf("afterId 0 %v", got)
	}
	// Neither moved a cursor: another session still reads all five as unread.
	h.as("b", "read_messages", map[string]any{"latest": true})
	if n := h.count(`SELECT COUNT(*) FROM read_cursors WHERE instance_id = 'codex:b'`); n != 0 {
		t.Fatalf("history wrote %d cursors", n)
	}
	cursor := h.count(`SELECT last_read_id FROM read_cursors WHERE instance_id = 'codex:a'`)
	if cursor != 0 {
		t.Fatalf("cursor moved to %d", cursor)
	}
	h.fails(400, "read_messages takes latest or afterId, not both.", "read_messages", map[string]any{"latest": true, "afterId": 1}, "mcp-1")
	h.fails(400, "Invalid arguments", "read_messages", map[string]any{"afterId": -1}, "mcp-1")
}

func TestUnresolvedIdentity(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	h.ok("send_message", map[string]any{"message": "x"}, "mcp-0")
	if r := h.callAs("read_messages", map[string]any{}, "mcp-1", codex("lost")); r.status != 400 || r.err != "session cannot be resolved; retry" {
		t.Fatalf("unread: %d %s", r.status, r.err)
	}
	if r := h.callAs("send_message", map[string]any{"message": "y"}, "mcp-1", codex("lost")); r.status != 400 {
		t.Fatalf("send: %d %s", r.status, r.err)
	}
	if n := h.count(`SELECT COUNT(*) FROM read_cursors`); n != 0 {
		t.Fatalf("%d cursors", n)
	}
	for _, args := range []map[string]any{{"latest": true}, {"afterId": 0}} {
		r := h.callAs("read_messages", args, "mcp-1", codex("lost"))
		if r.status != 200 || !strings.Contains(string(r.result), `"text":"x"`) {
			t.Fatalf("history %v: %d %s", args, r.status, r.err)
		}
	}
}

func TestMeetingMessageNumbers(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	m1 := h.as("a", "start_meeting", map[string]any{"topic": "one"})["meetingId"].(string)
	m2 := h.as("a", "start_meeting", map[string]any{"topic": "two"})["meetingId"].(string)
	// Interleaved: each meeting numbers its own messages from 1.
	for i, m := range []string{m1, m2, m1, m2, m1} {
		sent := h.as("b", "send_message", map[string]any{"message": fmt.Sprintf("%s-%d", m, i), "meetingId": m})
		want := map[string]float64{m1: float64(i/2 + 1), m2: float64(i/2 + 1)}[m]
		if sent["messageId"] != want {
			t.Fatalf("send %d to %s: messageId %v, want %v", i, m, sent["messageId"], want)
		}
	}
	ids := func(res map[string]any) []float64 {
		out := []float64{}
		for _, m := range res["messages"].([]any) {
			out = append(out, m.(map[string]any)["id"].(float64))
		}
		return out
	}
	// Unread reads show the numbers and keep the cursor across a count cut.
	if got := ids(h.as("a", "read_messages", map[string]any{"meetingId": m1, "count": 2})); !slices.Equal(got, []float64{1, 2}) {
		t.Fatalf("m1 first %v", got)
	}
	if got := ids(h.as("a", "read_messages", map[string]any{"meetingId": m1})); !slices.Equal(got, []float64{3}) {
		t.Fatalf("m1 second %v", got)
	}
	if got := ids(h.as("a", "read_messages", map[string]any{"meetingId": m2})); !slices.Equal(got, []float64{1, 2}) {
		t.Fatalf("m2 %v", got)
	}
	// afterId in a meeting is a meeting number.
	if got := messageTexts(h.as("a", "read_messages", map[string]any{"meetingId": m1, "afterId": 1})); !slices.Equal(got, []string{m1 + "-2", m1 + "-4"}) {
		t.Fatalf("afterId %v", got)
	}
	if got := ids(h.as("a", "read_messages", map[string]any{"meetingId": m2, "latest": true, "count": 1})); !slices.Equal(got, []float64{2}) {
		t.Fatalf("latest %v", got)
	}
}
