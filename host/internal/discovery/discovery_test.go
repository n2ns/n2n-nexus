package discovery

import (
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/protocol"
)

// Query is the contract's discovery datagram.
var Query = func() string {
	c, err := protocol.Load()
	if err != nil {
		panic(err)
	}
	return c.Hook.DiscoveryQuery
}()

// freeUDPPort returns a UDP port nothing is bound to right now.
func freeUDPPort(t *testing.T) int {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	return pc.LocalAddr().(*net.UDPAddr).Port
}

// query sends payload to the discovery port on loopback and returns the reply, or nil after a timeout.
func query(t *testing.T, port int, payload string) []byte {
	t.Helper()
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		return nil
	}
	return buf[:n]
}

func TestAnswersQuery(t *testing.T) {
	port := freeUDPPort(t)
	stop, err := Start(context.Background(), Options{Query: Query, Host: "0.0.0.0", HTTPPort: 5799, DiscoveryPort: port, Version: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	raw := query(t, port, Query)
	if raw == nil {
		t.Fatal("no reply")
	}
	// Exactly the fields and order of the TS responder.
	if string(raw) != `{"service":"n2n-nexus","version":"1.2.3","host":"0.0.0.0","port":5799}` {
		t.Fatalf("reply %s", raw)
	}
	var r Reply
	if err := json.Unmarshal(raw, &r); err != nil || r.Port != 5799 {
		t.Fatalf("reply %s: %v", raw, err)
	}
	if got := query(t, port, "something else"); got != nil {
		t.Fatalf("answered a foreign datagram: %s", got)
	}
}

func TestStopReleasesPort(t *testing.T) {
	port := freeUDPPort(t)
	ctx, cancel := context.WithCancel(context.Background())
	stop, err := Start(ctx, Options{Query: Query, Host: "192.168.1.5", HTTPPort: 1, DiscoveryPort: port, Version: "v"})
	if err != nil {
		t.Fatal(err)
	}
	if string(query(t, port, Query)) != `{"service":"n2n-nexus","version":"v","host":"192.168.1.5","port":1}` {
		t.Fatal("no reply with the bind address")
	}
	cancel()
	stop()
	if got := query(t, port, Query); got != nil {
		t.Fatalf("still answering after stop: %s", got)
	}
	// A restarted host binds the port again.
	stop2, err := Start(context.Background(), Options{Query: Query, Host: "0.0.0.0", HTTPPort: 2, DiscoveryPort: port})
	if err != nil {
		t.Fatal(err)
	}
	stop2()
}

func TestLoopbackDoesNotAnswer(t *testing.T) {
	for _, h := range []string{"127.0.0.1", "localhost", "::1", "127.0.0.2"} {
		port := freeUDPPort(t)
		stop, err := Start(context.Background(), Options{Query: Query, Host: h, HTTPPort: 1, DiscoveryPort: port})
		if err != nil {
			t.Fatal(err)
		}
		if got := query(t, port, Query); got != nil {
			t.Fatalf("%s: answered %s", h, got)
		}
		stop()
	}
	if !AnswersDiscovery("0.0.0.0") || !AnswersDiscovery("10.0.0.1") {
		t.Fatal("LAN addresses must answer")
	}
}
