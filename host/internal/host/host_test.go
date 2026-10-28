package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

// GET /health reports the agent sessions that are not offline.
func TestHealthCountsOnlineSessions(t *testing.T) {
	s := config.Defaults()
	s.Port = 0
	h, err := Start(Options{Version: "test", DataDir: t.TempDir(), Settings: s, Logger: NewLogger(io.Discard)})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()
	base := fmt.Sprintf("http://%s", h.Addr)
	online := func() any {
		res, err := http.Get(base + "/health")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		sessions, _ := body["sessions"].(map[string]any)
		return sessions["online"]
	}
	hook := func(event string) {
		raw, _ := json.Marshal(map[string]any{"client": "codex", "input": map[string]any{"hook_event_name": event, "session_id": "s", "cwd": "/tmp/x", "machine": map[string]any{"hostname": "box", "platform": "linux", "utcOffset": 0}}})
		res, err := http.Post(base+"/api/hook", "application/json", bytes.NewReader(raw))
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("%s: %v %v", event, res, err)
		}
		res.Body.Close()
	}
	if got := online(); got != float64(0) {
		t.Fatalf("online before any session: %v, want 0", got)
	}
	hook("SessionStart")
	if got := online(); got != float64(1) {
		t.Fatalf("online after SessionStart: %v, want 1", got)
	}
	hook("SessionEnd")
	if got := online(); got != float64(0) {
		t.Fatalf("online after SessionEnd: %v, want 0", got)
	}
}

// An IPv4 address binds IPv4 only; the ready line shows the address bound.
func TestListenIPv4Only(t *testing.T) {
	s := config.Defaults()
	s.Host, s.Port, s.DiscoveryPort = "0.0.0.0", 0, 0
	h, err := Start(Options{Version: "test", DataDir: t.TempDir(), Settings: s, Logger: NewLogger(io.Discard)})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()
	if line := ReadyLine("test", h); !strings.HasPrefix(line, "test listening on http://0.0.0.0:") {
		t.Fatalf("ready line %q, want http://0.0.0.0:<port>", line)
	}
	if c, err := net.Dial("tcp6", fmt.Sprintf("[::1]:%d", h.Addr.Port)); err == nil {
		c.Close()
		t.Fatal("a host bound to 0.0.0.0 accepts IPv6 connections")
	}
}

func TestListenNetwork(t *testing.T) {
	for host, want := range map[string]string{"0.0.0.0": "tcp4", "127.0.0.1": "tcp4", "192.168.1.9": "tcp4", "::": "tcp6", "::1": "tcp6", "localhost": "tcp", "nexus.lan": "tcp"} {
		if got := listenNetwork(host); got != want {
			t.Errorf("%s: %s, want %s", host, got, want)
		}
	}
}
