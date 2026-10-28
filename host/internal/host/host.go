// Package host assembles and runs one host: the database, the tools, the HTTP
// server, LAN discovery, the hourly maintenance and the stance reminders.
// serve and the tray both use it.
package host

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/agents"
	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/core"
	"github.com/n2ns/n2n-nexus/host/internal/discovery"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
	"github.com/n2ns/n2n-nexus/host/internal/testhooks"
)

// MaintainInterval is how often the cleanup runs.
const MaintainInterval = time.Hour

// RemindInterval is how often meetings are checked for missing stances on their drafts.
const RemindInterval = time.Minute

// Options configure a host.
type Options struct {
	Version  string
	DataDir  string
	Settings config.Settings
	Logger   *log.Logger
	Test     testhooks.Options
	// SupervisorPID is the PID of the `serve --supervise` that started this
	// host, 0 if none; it is recorded in host.lock.
	SupervisorPID int
	// Role is recorded in host.lock: RoleTray for the tray; "" is RoleSupervised
	// with a SupervisorPID, else RoleServe.
	Role string
}

// Host is a running host.
type Host struct {
	Addr   *net.TCPAddr
	server *http.Server
	store  *store.Store
	agents *agents.Agents
	cancel context.CancelFunc
	done   chan struct{}
	logger *log.Logger
	lock   *Lock
	// stopDiscovery closes the discovery socket.
	stopDiscovery func()
}

// Start takes the data directory's single-instance lock, opens the database
// and starts serving; it returns once the port is bound.
func Start(o Options) (*Host, error) {
	role := o.Role
	if role == "" {
		role = RoleServe
		if o.SupervisorPID > 0 {
			role = RoleSupervised
		}
	}
	lock, err := AcquireLock(o.DataDir, os.Getpid(), o.SupervisorPID, role)
	if err != nil {
		return nil, err
	}
	h, err := start(o, lock)
	if err != nil {
		lock.Release()
		return nil, err
	}
	return h, nil
}

func start(o Options, lock *Lock) (*Host, error) {
	contract, err := protocol.Load()
	if err != nil {
		return nil, err
	}
	st, err := store.Open(o.DataDir)
	if err != nil {
		return nil, err
	}
	clk := testhooks.NewClock()
	listenWait := time.Duration(contract.Hook.Timing.ListenWaitMs) * time.Millisecond
	if o.Test.ListenWaitMs > 0 {
		listenWait = time.Duration(o.Test.ListenWaitMs) * time.Millisecond
	}
	ag, err := agents.New(agents.Options{Store: st, Clock: clk, Contract: contract, Logger: o.Logger, ListenWait: listenWait, MaxAutoTurns: o.Settings.MaxAutoTurns, RetentionDays: o.Settings.RetentionDays})
	if err != nil {
		st.Close()
		return nil, err
	}
	srv := api.New(api.Options{
		Version: o.Version, Contract: contract, Clock: clk,
		AllowedHosts: o.Settings.AllowedHosts, RateLimit: o.Settings.RateLimit, RateBurst: o.Settings.RateBurst,
		Logger: o.Logger, Health: ag.Health, SessionOf: ag.SessionOf,
	})
	c := core.New(core.Deps{Store: st, Clock: clk, Contract: contract, Logger: o.Logger, Identities: ag, Meetings: ag,
		Cleaner: ag, MeetingRetentionDays: o.Settings.MeetingRetentionDays, RetentionDays: o.Settings.RetentionDays})
	c.Register(srv)
	ag.Register(srv)
	if missing := srv.Missing(); len(missing) > 0 {
		o.Logger.Printf("tools without a handler: %v", missing)
	}

	ln, err := net.Listen(listenNetwork(o.Settings.Host), net.JoinHostPort(o.Settings.Host, fmt.Sprint(o.Settings.Port)))
	if err != nil {
		st.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &Host{Addr: ln.Addr().(*net.TCPAddr), store: st, agents: ag, cancel: cancel, done: make(chan struct{}), logger: o.Logger, lock: lock}
	h.server = &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}

	maintain := func() {
		line, err := c.Maintain(ctx)
		if err != nil {
			o.Logger.Printf("maintenance: %v", err)
		} else if line != "" {
			o.Logger.Print(line)
		}
	}
	h.stopDiscovery = func() {}
	if stop, err := discovery.Start(ctx, discovery.Options{Host: o.Settings.Host, HTTPPort: h.Addr.Port, DiscoveryPort: o.Settings.DiscoveryPort, Version: o.Version, Logger: o.Logger}); err != nil {
		o.Logger.Printf("LAN discovery unavailable: %v", err)
	} else {
		h.stopDiscovery = stop
	}
	go func() {
		maintain()
		t := time.NewTicker(MaintainInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				maintain()
			}
		}
	}()
	if o.Settings.StanceReminderMinutes > 0 {
		after := time.Duration(o.Settings.StanceReminderMinutes) * time.Minute
		go func() {
			t := time.NewTicker(RemindInterval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					line, err := c.RemindStances(ctx, after)
					if err != nil {
						o.Logger.Printf("stance reminders: %v", err)
					} else if line != "" {
						o.Logger.Print(line)
					}
				}
			}
		}()
	}
	go func() {
		defer close(h.done)
		if err := h.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			o.Logger.Printf("server: %v", err)
		}
	}()
	return h, nil
}

// listenNetwork binds an IPv4 literal (0.0.0.0 included) to IPv4 only and an
// IPv6 literal to IPv6 only; a name binds to what it resolves to.
func listenNetwork(host string) string {
	ip := net.ParseIP(host)
	switch {
	case ip == nil:
		return "tcp"
	case ip.To4() != nil:
		return "tcp4"
	default:
		return "tcp6"
	}
}

// OnlineSessions counts the agent sessions that are not offline.
func (h *Host) OnlineSessions() (int, error) { return h.agents.OnlineSessions() }

// Stop ends held waits, lets in-flight requests finish (up to 5 s), closes the
// database and releases the lock.
func (h *Host) Stop() {
	// Answer held hooks before closing: background waits retry, listening Stops end.
	h.agents.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = h.server.Shutdown(ctx)
	<-h.done
	h.cancel()
	h.stopDiscovery()
	h.store.Close()
	h.lock.Release()
}
