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
	// A host bound to a name is addressed by that name, by its own health probes among others.
	allowed := o.Settings.AllowedHosts
	if o.Settings.Host != "" && net.ParseIP(o.Settings.Host) == nil {
		allowed = append(append([]string{}, allowed...), o.Settings.Host)
	}
	srv := api.New(api.Options{
		Version: o.Version, Contract: contract, Clock: clk,
		AllowedHosts: allowed, RateLimit: o.Settings.RateLimit, RateBurst: o.Settings.RateBurst,
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

	// run runs a periodic job and logs its line or its error.
	run := func(label string, job func(context.Context) (string, error)) {
		line, err := job(ctx)
		if err != nil {
			o.Logger.Printf("%s: %v", label, err)
		} else if line != "" {
			o.Logger.Print(line)
		}
	}
	// every runs a job every interval until the host stops.
	every := func(interval time.Duration, label string, job func(context.Context) (string, error)) {
		go func() {
			t := time.NewTicker(interval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					run(label, job)
				}
			}
		}()
	}
	h.stopDiscovery = func() {}
	if stop, err := discovery.Start(ctx, discovery.Options{Query: contract.Hook.DiscoveryQuery, Host: o.Settings.Host, HTTPPort: h.Addr.Port, DiscoveryPort: o.Settings.DiscoveryPort, Version: o.Version, Logger: o.Logger}); err != nil {
		o.Logger.Printf("LAN discovery unavailable: %v", err)
	} else {
		h.stopDiscovery = stop
	}
	// The first cleanup completes before the host answers: nothing past its TTL is served as live.
	run("maintenance", c.Maintain)
	every(MaintainInterval, "maintenance", c.Maintain)
	if o.Settings.StanceReminderMinutes > 0 {
		after := time.Duration(o.Settings.StanceReminderMinutes) * time.Minute
		every(RemindInterval, "stance reminders", func(ctx context.Context) (string, error) { return c.RemindStances(ctx, after) })
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
