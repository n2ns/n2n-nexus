// Package discovery answers LAN discovery queries ("n2n-nexus/discover" on the
// discovery UDP port) when the host listens on a non-loopback address. It
// behaves like startDiscoveryResponder in src/client/discovery.ts: an IPv4
// socket on all interfaces with SO_REUSEADDR, answering each query with
// {"service":"n2n-nexus","version","host","port"}, where host is the HTTP bind
// address and port the HTTP port.
package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
)

// Options configure the responder.
type Options struct {
	Host          string // the address the HTTP server listens on
	Query         string // the datagram a client broadcasts (discoveryQuery in contract/hook.json)
	HTTPPort      int
	DiscoveryPort int
	Version       string
	Logger        *log.Logger
}

// Reply is the answer to a query.
type Reply struct {
	Service string `json:"service"`
	Version string `json:"version"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
}

// AnswersDiscovery reports whether a host bound to host is reachable from the
// LAN and so answers discovery (answersDiscovery in src/client/discovery.ts).
func AnswersDiscovery(host string) bool {
	switch host {
	case "127.0.0.1", "localhost", "::1":
		return false
	}
	return !strings.HasPrefix(host, "127.")
}

// Start binds the discovery port and answers queries until ctx ends or the
// returned stop is called; stop closes the socket before it returns. For a
// loopback host it binds nothing and returns a no-op stop.
func Start(ctx context.Context, o Options) (stop func(), err error) {
	if !AnswersDiscovery(o.Host) {
		return func() {}, nil
	}
	reply, err := json.Marshal(Reply{Service: "n2n-nexus", Version: o.Version, Host: o.Host, Port: o.HTTPPort})
	if err != nil {
		return nil, err
	}
	lc := net.ListenConfig{Control: reuseAddr}
	pc, err := lc.ListenPacket(ctx, "udp4", fmt.Sprintf(":%d", o.DiscoveryPort))
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 512)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				// A failed send can surface here (ICMP port unreachable on Windows); keep answering.
				if o.Logger != nil {
					o.Logger.Printf("discovery: %v", err)
				}
				continue
			}
			if string(buf[:n]) == o.Query {
				_, _ = pc.WriteTo(reply, addr)
			}
		}
	}()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			_ = pc.Close()
			<-done
		})
	}
	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-done:
		}
	}()
	return stop, nil
}
