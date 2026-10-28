package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

// Stop ends a listening Stop and lets a background wait retry on the restarted host.
func TestStopAnswersHeldHooks(t *testing.T) {
	for _, tc := range []struct{ event, want string }{
		{"Stop", `{"output":null}`},
		{"BackgroundWait", `{"output":{"timeout":true}}`},
	} {
		t.Run(tc.event, func(t *testing.T) {
			settings := config.Defaults()
			settings.Port = 0
			h, err := Start(Options{Version: "test", DataDir: t.TempDir(), Settings: settings, Logger: log.New(io.Discard, "", 0)})
			if err != nil {
				t.Fatal(err)
			}
			base := fmt.Sprintf("http://%s", h.Addr)
			post := func(path string, body any) (*http.Response, error) {
				raw, _ := json.Marshal(body)
				return http.Post(base+path, "application/json", bytes.NewReader(raw))
			}
			hook := func(event string, extra map[string]any) map[string]any {
				input := map[string]any{"hook_event_name": event, "session_id": "s", "cwd": "/tmp/x", "machine": map[string]any{"hostname": "box", "platform": "linux", "environment": "", "utcOffset": 0}}
				for k, v := range extra {
					input[k] = v
				}
				return map[string]any{"client": "codex", "input": input}
			}
			for _, step := range []map[string]any{hook("SessionStart", nil)} {
				if res, err := post("/api/hook", step); err != nil || res.StatusCode != 200 {
					t.Fatalf("SessionStart: %v %v", res, err)
				} else {
					res.Body.Close()
				}
			}
			if res, err := post("/api/tools/call", map[string]any{"tool": "listen", "args": map[string]any{"on": true}, "instanceId": "i", "caller": map[string]any{"client": "codex", "sessionId": "s"}}); err != nil || res.StatusCode != 200 {
				t.Fatalf("listen: %v %v", res, err)
			} else {
				res.Body.Close()
			}
			type result struct {
				status int
				body   string
				err    error
			}
			done := make(chan result, 1)
			go func() {
				res, err := post("/api/hook", hook(tc.event, map[string]any{"stop_hook_active": true}))
				if err != nil {
					done <- result{err: err}
					return
				}
				defer res.Body.Close()
				b, _ := io.ReadAll(res.Body)
				done <- result{status: res.StatusCode, body: string(b)}
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var status string
				if err := h.store.DB.QueryRow("SELECT status FROM agent_sessions WHERE id = 'codex:s'").Scan(&status); err != nil {
					t.Fatal(err)
				}
				if status == "listening" {
					break
				}
				if time.Now().After(deadline) {
					h.Stop()
					t.Fatal("hook was not held")
				}
				time.Sleep(5 * time.Millisecond)
			}
			h.Stop()
			select {
			case r := <-done:
				if r.err != nil || r.status != 200 || r.body != tc.want {
					t.Fatalf("held %s hook got %d %q %v; want 200 %s", tc.event, r.status, r.body, r.err, tc.want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("held hook did not return")
			}
		})
	}
}
