package agents

import (
	"context"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/store"
)

var dmTools = []struct {
	name string
	args map[string]any
}{
	{"peers", nil}, {"send", map[string]any{"to": "x", "text": "hi"}}, {"read", nil},
	{"reply", map[string]any{"messageId": "m", "text": "hi"}}, {"listen", map[string]any{"on": true}},
	{"set_profile", map[string]any{"note": "n"}},
}

func TestToolsNeedASession(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "known")
	noSession := func(r toolReply) {
		t.Helper()
		if r.status != 400 || r.error != texts.NoAgentSessionError {
			t.Fatalf("got %d %q", r.status, r.error)
		}
	}
	for _, tool := range dmTools {
		noSession(h.call(nil, tool.name, tool.args))                                                        // other MCP clients
		noSession(h.codex("missing", tool.name, tool.args))                                                 // Codex without hooks
		noSession(h.call(map[string]any{"client": "claude", "toolUseId": "unbound"}, tool.name, tool.args)) // unbound toolUseId
	}
	// A malformed caller names no session.
	noSession(h.call(map[string]any{"client": "claude"}, "peers", nil))
	noSession(h.call(map[string]any{"client": "cursor", "sessionId": "x"}, "peers", nil))
}

func TestToolsValidateAndRefreshActivity(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "a")
	eq(t, h.codex("a", "read", map[string]any{"count": 51}).status, 400)
	eq(t, h.codex("a", "send", map[string]any{"to": "x", "text": ""}).status, 400)
	eq(t, h.codex("a", "listen", nil).status, 400)
	eq(t, h.codex("a", "send", map[string]any{"to": "x", "text": strings.Repeat("y", testContract.Hook.Limits.MaxMessageChars+1)}).status, 400)

	h.at(time.Minute)
	eq(t, h.codex("a", "listen", map[string]any{"on": false}).status, 200)
	eq(t, h.session("codex:a").LastActiveAt, store.ISO(h.t0.Add(time.Minute)))
}

func peerIDs(r toolReply) [][2]string {
	var out [][2]string
	for _, p := range r.result["peers"].([]any) {
		m := p.(map[string]any)
		out = append(out, [2]string{m["id"].(string), m["status"].(string)})
	}
	return out
}

func TestPeers(t *testing.T) {
	h := start(t)
	window := ms(timing.PeerWindowMs)
	h.at(-window - time.Minute)
	h.hook("codex", "SessionStart", "gone", map[string]any{"cwd": "/work/old"})
	h.hook("codex", "SessionEnd", "gone")
	h.hook("codex", "SessionStart", "stale", map[string]any{"cwd": "/work/stale"}) // never ended, but stale: offline and too old to list
	h.at(-2 * time.Second)
	h.hook("claude", "SessionStart", "recent-offline")
	h.hook("claude", "SessionEnd", "recent-offline")
	h.at(-time.Second)
	h.hook("claude", "SessionStart", "me", map[string]any{"cwd": "/work/mine"})
	h.hook("codex", "UserPromptSubmit", "busy")
	h.at(0)

	r := h.claude("me", "peers", nil)
	want := map[string]any{"id": "claude:me", "name": "claude@mine#me", "title": "", "client": "claude", "cwd": "/work/mine", "hostname": "box", "platform": "linux", "environment": "", "utcOffset": float64(0), "label": "", "note": "", "status": "idle", "lastActiveAt": store.ISO(h.t0)}
	if !reflect.DeepEqual(r.result["self"], want) {
		t.Fatalf("self = %v", r.result["self"])
	}
	if got := peerIDs(r); !reflect.DeepEqual(got, [][2]string{{"codex:busy", "working"}}) {
		t.Fatalf("peers = %v", got)
	}
	all := h.claude("me", "peers", map[string]any{"includeOffline": true})
	if got := peerIDs(all); !reflect.DeepEqual(got, [][2]string{{"codex:busy", "working"}, {"claude:recent-offline", "offline"}}) {
		t.Fatalf("peers = %v", got)
	}
	eq(t, h.status("codex:stale"), "offline")
	var keys []string
	for k := range r.result["peers"].([]any)[0].(map[string]any) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	eq(t, strings.Join(keys, ","), "client,cwd,environment,hostname,id,label,lastActiveAt,name,note,platform,status,title,utcOffset")
}

func TestListenTool(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "a")
	eq(t, h.codex("a", "listen", map[string]any{"on": true}).result["listening"], any(true))
	eq(t, h.session("codex:a").Listening, true)
	eq(t, h.codex("a", "listen", map[string]any{"on": false}).result["listening"], any(false))
	eq(t, h.session("codex:a").Listening, false)
}

func TestSetProfile(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "a")
	h.hook("codex", "SessionStart", "b")
	h.hook("codex", "SessionStart", "c")
	h.hook("codex", "SessionEnd", "c")

	eq(t, h.codex("a", "set_profile", nil).status, 400)
	eq(t, h.codex("a", "set_profile", map[string]any{"name": "has space"}).status, 400)
	eq(t, h.codex("a", "set_profile", map[string]any{"name": strings.Repeat("x", 49)}).status, 400)
	eq(t, h.codex("a", "set_profile", map[string]any{"note": strings.Repeat("n", testContract.Hook.Limits.MaxNoteChars+1)}).status, 400)

	taken := h.codex("a", "set_profile", map[string]any{"name": "codex@proj#b"})
	eq(t, taken.status, 400)
	contains(t, taken.error, "already used")
	eq(t, h.session("codex:a").Name, "codex@proj#a")

	// The offline session's name is free; the session's own current name is fine too.
	renamed := h.codex("a", "set_profile", map[string]any{"name": "codex@proj#c", "note": "reviewing"}).result["profile"].(map[string]any)
	eq(t, renamed["id"], any("codex:a"))
	eq(t, renamed["name"], any("codex@proj#c"))
	eq(t, renamed["note"], any("reviewing"))
	eq(t, h.codex("a", "set_profile", map[string]any{"name": "codex@proj#c"}).status, 200)
	noteOnly := h.codex("a", "set_profile", map[string]any{"note": ""}).result["profile"].(map[string]any)
	eq(t, noteOnly["name"], any("codex@proj#c"))
	eq(t, noteOnly["note"], any(""))
}

func TestSendResolvesRecipient(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "a", map[string]any{"cwd": "/work/alpha"})
	h.hook("codex", "SessionStart", "b", map[string]any{"cwd": "/work/beta"})
	h.hook("codex", "SessionStart", "off", map[string]any{"cwd": "/work/off"})
	h.hook("codex", "SessionEnd", "off")

	byName := h.claude("a", "send", map[string]any{"to": "codex@beta#b", "text": "by name"})
	eq(t, byName.status, 200)
	if byName.result["messageId"].(string) == "" || !reflect.DeepEqual(byName.result["to"], map[string]any{"id": "codex:b", "name": "codex@beta#b", "status": "idle"}) {
		t.Fatal(byName.result)
	}
	byID := h.claude("a", "send", map[string]any{"to": "codex:off", "text": "to offline"})
	if !reflect.DeepEqual(byID.result["to"], map[string]any{"id": "codex:off", "name": "codex@off#off", "status": "offline"}) {
		t.Fatal(byID.result)
	}
	offlineName := h.claude("a", "send", map[string]any{"to": "codex@off#off", "text": "x"})
	eq(t, offlineName.status, 400)
	contains(t, offlineName.error, "Unknown recipient")
	contains(t, h.claude("a", "send", map[string]any{"to": "nobody", "text": "x"}).error, "Unknown recipient")

	self := h.claude("a", "send", map[string]any{"to": "claude@alpha#a", "text": "x"})
	eq(t, self.status, 400)
	contains(t, self.error, "yourself")
	eq(t, h.claude("a", "send", map[string]any{"to": "claude:a", "text": "x"}).status, 400)

	// Offline recipients keep their messages and are told when they come back.
	h.hook("codex", "SessionStart", "off", map[string]any{"cwd": "/work/off"})
	contains(t, h.hook("codex", "UserPromptSubmit", "off").context(), "to offline")
}

func TestReadPages(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	var ids []string
	for _, text := range []string{"m1", "m2", "m3"} {
		ids = append(ids, h.send("s", "claude:r", text, false))
	}
	first := h.claude("r", "read", map[string]any{"count": 2})
	msgs := first.result["messages"].([]any)
	eq(t, len(msgs), 2)
	for i, m := range msgs {
		m := m.(map[string]any)
		eq(t, m["messageId"], any(ids[i]))
		if !reflect.DeepEqual(m["from"], map[string]any{"id": "codex:s", "name": "codex@proj#s"}) || m["replyTo"] != nil || m["createdAt"] != store.ISO(h.t0) {
			t.Fatal(m)
		}
		eq(t, m["text"], any([]string{"m1", "m2"}[i]))
	}
	eq(t, first.result["remaining"], any(float64(1)))
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id IN (?, ?) AND status = 'read' AND read_at IS NOT NULL AND notified_at IS NOT NULL", ids[0], ids[1]), 2)

	second := h.claude("r", "read", nil)
	eq(t, len(second.result["messages"].([]any)), 1)
	eq(t, second.result["messages"].([]any)[0].(map[string]any)["text"], any("m3"))
	eq(t, second.result["remaining"], any(float64(0)))
	empty := h.claude("r", "read", nil)
	eq(t, len(empty.result["messages"].([]any)), 0)
	if out := h.hook("claude", "UserPromptSubmit", "r"); out != nil {
		t.Fatal(out)
	}
}

func TestReply(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "SessionStart", "other")
	original := h.send("s", "claude:r", "question", false)

	notMine := h.claude("other", "reply", map[string]any{"messageId": original, "text": "x"})
	eq(t, notMine.status, 400)
	contains(t, notMine.error, "Message '"+original+"' not found or not sent to you; use a messageId from a notification or read.")
	eq(t, h.codex("s", "reply", map[string]any{"messageId": original, "text": "x"}).status, 400) // the sender cannot reply to its own message
	eq(t, h.claude("r", "reply", map[string]any{"messageId": "no-such", "text": "x"}).status, 400)

	h.claude("r", "read", nil) // read messages can still be answered
	replied := h.claude("r", "reply", map[string]any{"messageId": original, "text": "answer"})
	if !reflect.DeepEqual(replied.result["to"], map[string]any{"id": "codex:s", "name": "codex@proj#s", "status": "idle"}) {
		t.Fatal(replied.result)
	}
	inbox := h.codex("s", "read", nil).result["messages"].([]any)
	eq(t, len(inbox), 1)
	m := inbox[0].(map[string]any)
	eq(t, m["messageId"], replied.result["messageId"])
	eq(t, m["replyTo"], any(original))
	eq(t, m["text"], any("answer"))
	if !reflect.DeepEqual(m["from"], map[string]any{"id": "claude:r", "name": "claude@proj#r"}) {
		t.Fatal(m)
	}
}

func TestMaintain(t *testing.T) {
	h := start(t)
	ctx := context.Background()
	line, err := h.ag.Maintain(ctx)
	if err != nil || line != "" {
		t.Fatalf("empty database: %q %v", line, err)
	}
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	read := h.send("s", "codex:r", "read me", false)
	h.codex("r", "read", nil)
	stale := h.send("s", "codex:r", "never read", false)
	h.hook("codex", "PreToolUse", "s", map[string]any{"tool_use_id": "toolu_old"})

	// Past the message TTL: the unread message expires, its sender gets a
	// notice (which wakes its listening Stop) and the binding is gone.
	h.codex("s", "listen", map[string]any{"on": true})
	waiting := h.openHook("codex", "Stop", "s", stopActive)
	h.untilStatus("codex:s", "listening")
	ttl := ms(timing.MessageTtlMs)
	h.at(ttl + time.Second)
	line, err = h.ag.Maintain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, line, "agents: 1 messages expired; deleted 0 messages, 0 notices, 1 tool-use bindings")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'expired'", stale), 1)
	contains(t, waiting.wait(t).str("reason"), "expired unread")
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings"), 0)
	answer := h.codex("r", "reply", map[string]any{"messageId": read, "text": "answer"}).result["messageId"].(string)

	// 30 days later: the read and the expired message and the delivered notice
	// go; the newer reply stays, without its link to the deleted original.
	h.at(ttl + RetentionDays*24*time.Hour + 2*time.Second)
	line, err = h.ag.Maintain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, line, "agents: 1 messages expired; deleted 2 messages, 1 notices, 0 tool-use bindings")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages"), 1)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND reply_to IS NULL", answer), 1)
	eq(t, h.count("SELECT COUNT(*) FROM agent_notices WHERE notified_at IS NULL"), 1)
	eq(t, h.count("SELECT COUNT(*) FROM agent_notices"), 1)
	line, err = h.ag.Maintain(ctx)
	if err != nil || line != "" {
		t.Fatalf("nothing left to do: %q %v", line, err)
	}
}
