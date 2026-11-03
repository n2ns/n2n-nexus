package agents

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestInProject(t *testing.T) {
	for _, c := range []struct {
		cwd, dir string
		want     bool
	}{
		{"/work/proj", "/work/proj", true},
		{"/work/proj/sub", "/work/proj", true},
		{"/work/proj/sub", "/work/proj/", true},
		{"/work/project", "/work/proj", false},
		{"/work", "/work/proj", false},
		{"/anything", "/", true},
		{`C:\work\proj\sub`, `C:\work\proj`, true},
		{`C:\work\project`, `C:\work\proj`, false},
		{`C:\work\proj`, `C:\work\proj\`, true},
	} {
		if got := inProject(c.cwd, c.dir); got != c.want {
			t.Errorf("inProject(%q, %q) = %v, want %v", c.cwd, c.dir, got, c.want)
		}
	}
}

// broadcastCopies returns, per session, the copies of broadcast id it holds.
func (h *harness) broadcastCopies(id string) map[string]int {
	h.t.Helper()
	rows, err := h.st.DB.Query("SELECT to_id, COUNT(*) FROM agent_messages WHERE broadcast_id = ? GROUP BY to_id", id)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]int{}
	for rows.Next() {
		var to string
		var n int
		if err := rows.Scan(&to, &n); err != nil {
			h.t.Fatal(err)
		}
		got[to] = n
	}
	return got
}

func TestBroadcastGoesToOnlineSessionsOnly(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s", map[string]any{"cwd": "/work/proj"})
	h.hook("codex", "SessionStart", "same", map[string]any{"cwd": "/work/proj/sub"})
	h.hook("claude", "SessionStart", "other", map[string]any{"cwd": "/work/other"})
	h.hook("codex", "SessionStart", "off", map[string]any{"cwd": "/work/proj"})
	h.hook("codex", "SessionEnd", "off")

	// An active meeting changes nothing for a broadcast.
	h.meeting("m1", map[string]string{"codex:s": "active", "codex:same": "active"})
	all := h.codex("s", "broadcast", map[string]any{"text": "rules changed"})
	eq(t, all.status, 200)
	id, _ := all.result["broadcastId"].(string)
	if id == "" || len(all.result) != 1 {
		t.Fatalf("result: %v", all.result)
	}
	// Every online session but the sender; the offline one gets nothing, not even when it comes back.
	if got := h.broadcastCopies(id); !reflect.DeepEqual(got, map[string]int{"codex:same": 1, "claude:other": 1}) {
		t.Fatal(got)
	}
	h.hook("codex", "SessionStart", "off", map[string]any{"cwd": "/work/proj"})
	if out := h.hook("codex", "UserPromptSubmit", "off"); out != nil {
		t.Fatalf("offline session got the broadcast: %v", out)
	}

	project := h.codex("s", "broadcast", map[string]any{"text": "proj only", "project": "/work/proj/"})
	eq(t, project.status, 200)
	if got := h.broadcastCopies(project.result["broadcastId"].(string)); !reflect.DeepEqual(got, map[string]int{"codex:same": 1, "codex:off": 1}) {
		t.Fatal(got)
	}

	// Nobody online in it: still sent, to nobody.
	none := h.codex("s", "broadcast", map[string]any{"text": "x", "project": "/nowhere"})
	eq(t, none.status, 200)
	eq(t, len(h.broadcastCopies(none.result["broadcastId"].(string))), 0)
}

func TestBroadcastNotificationAndRead(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	// An idle recipient: by default no reply is asked, and its Stop is not held.
	sent := h.codex("s", "broadcast", map[string]any{"text": "fyi all", "project": "/work"})
	eq(t, sent.status, 200)
	id := sent.result["broadcastId"].(string)
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatalf("Stop held by a broadcast: %v", out)
	}
	ctx := h.hook("codex", "UserPromptSubmit", "r").context()
	contains(t, ctx, fmt.Sprintf(texts.BroadcastLine, id, fmt.Sprintf(texts.BroadcastToProject, "/work"))+"\nfyi all\n")
	contains(t, ctx, " ---\n"+texts.NoReplyMark+"\n")
	contains(t, ctx, texts.MessageInfoNote)

	// read marks it as a broadcast; a direct message is not.
	h.codex("s", "broadcast", map[string]any{"text": "second", "expectsReply": true})
	h.send("s", "codex:r", "direct", false)
	msgs := h.codex("r", "read", nil).result["messages"].([]any)
	eq(t, len(msgs), 2)
	eq(t, msgs[0].(map[string]any)["broadcastId"] != nil, true)
	eq(t, msgs[0].(map[string]any)["expectsReply"], any(true))
	eq(t, msgs[1].(map[string]any)["broadcastId"], any(nil))
}

func TestBroadcastToEveryOnlineSessionIsNamed(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	id := h.codex("s", "broadcast", map[string]any{"text": "hello"}).result["broadcastId"].(string)
	contains(t, h.hook("codex", "UserPromptSubmit", "r").context(), fmt.Sprintf(texts.BroadcastLine, id, texts.BroadcastToAll))
}

func TestBroadcastWakesListeningSessionsOnly(t *testing.T) {
	h := start(t, listenWait(2*time.Second))
	for _, id := range []string{"s", "work", "idle", "wait"} {
		h.hook("codex", "SessionStart", id)
	}
	h.hook("codex", "UserPromptSubmit", "work")
	h.hook("codex", "Stop", "wait", stopActive)
	waiting := h.openHook("codex", texts0BackgroundWait(), "wait")
	h.untilStatus("codex:wait", "listening")
	// wake is no argument of broadcast: it is dropped.
	eq(t, h.codex("s", "broadcast", map[string]any{"text": "heads up", "wake": true}).status, 200)

	// Listening: woken at once with it.
	contains(t, waiting.wait(t).str("wake"), "heads up")
	// Only the listening copy may wake.
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE broadcast_id IS NOT NULL AND wake = 1"), 1)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE broadcast_id IS NOT NULL AND wake = 1 AND to_id = 'codex:wait'"), 1)
	// Working: not interrupted; its next tool call shows it, and its Stop is not held.
	contains(t, h.hook("codex", "PostToolUse", "work").context(), "heads up")
	if out := h.hook("codex", "Stop", "work", stopInactive); out != nil {
		t.Fatalf("working session's Stop held by a broadcast: %v", out)
	}
	// Idle: not woken; its next prompt shows it.
	contains(t, h.hook("codex", "UserPromptSubmit", "idle").context(), "heads up")
}

func TestBroadcastReplyGoesToTheSender(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r1")
	h.hook("codex", "SessionStart", "r2")
	id := h.codex("s", "broadcast", map[string]any{"text": "who is free?", "expectsReply": true}).result["broadcastId"].(string)
	copyID := h.codex("r1", "read", nil).result["messages"].([]any)[0].(map[string]any)["messageId"].(string)
	replied := h.codex("r1", "reply", map[string]any{"messageId": copyID, "text": "me"})
	eq(t, replied.status, 200)
	eq(t, replied.result["to"].(map[string]any)["id"], any("codex:s"))
	// The sender is told which broadcast it answers; the other recipient gets nothing new.
	ctx := h.hook("codex", "UserPromptSubmit", "s").context()
	contains(t, ctx, fmt.Sprintf(texts.MessageReplyToBroadcast, id)+"\nme\n")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r2'"), 1)
}

func TestBroadcastExpiresWithoutTellingTheSender(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("s", "broadcast", map[string]any{"text": "never read"})
	h.at(time.Duration(timing.MessageTtlMs+1) * time.Millisecond)
	if _, err := h.ag.Cleanup(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE status = 'expired' AND broadcast_id IS NOT NULL"), 1)
	eq(t, h.count("SELECT COUNT(*) FROM agent_notices WHERE session_id = 'codex:s'"), 0)
}
