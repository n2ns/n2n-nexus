package agents

import (
	"database/sql"
	"errors"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

// identityRetryError: the call's instance has acted as a hooked conversation
// within the stale-session window, but this call's conversation cannot be
// resolved right now.
const identityRetryError = "The conversation session of this call cannot be resolved right now (the n2n-nexus hooks are installed for this adapter, but the session is not known yet). Retry the call; no unread cursor was moved."

// Identity resolves who a chat or meeting call acts as (api.IdentityResolver):
// the hooked conversation the caller names, else the adapter instance. It only
// reads the session tables: no refresh, expiry or revival as for the
// direct-message tools, and an expired tool-use binding is left in place.
// Call it outside any store transaction.
func (a *Agents) Identity(c api.Call) (api.Identity, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := c.Session
	if id == "" {
		var err error
		if id, err = a.callerSession(c, false); err != nil {
			return api.Identity{}, err
		}
	}
	if id != "" {
		s, err := getSession(a.db(), id)
		if err != nil {
			return api.Identity{}, err
		}
		if s != nil {
			if c.InstanceID != "" {
				if _, err := a.db().ExecContext(bg, `INSERT INTO hooked_instances (instance_id, last_seen_at) VALUES (?, ?)
					ON CONFLICT (instance_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
					c.InstanceID, a.iso(a.o.Clock.Now())); err != nil {
					return api.Identity{}, err
				}
			}
			return api.Identity{Kind: api.IdentitySession, ID: s.ID, Name: s.Name, Instance: c.Actor()}, nil
		}
	}
	if c.InstanceID != "" {
		var one int
		since := a.iso(a.o.Clock.Now().Add(-ms(a.o.Contract.Hook.Timing.StaleSessionMs)))
		err := a.db().QueryRowContext(bg, "SELECT 1 FROM hooked_instances WHERE instance_id = ? AND last_seen_at > ?", c.InstanceID, since).Scan(&one)
		if err == nil {
			return api.Identity{}, api.Errorf("%s", identityRetryError)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return api.Identity{}, err
		}
	}
	return api.Identity{Kind: api.IdentityInstance, ID: c.Actor(), Instance: c.Actor()}, nil
}

// SessionOf is the conversation a tool caller belongs to (api.Options.SessionOf),
// "" when it cannot be identified or the lookup fails: the call is then rate
// limited per instance. Read-only, like Identity; call it outside any store
// transaction.
func (a *Agents) SessionOf(c *api.Caller) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	id, err := a.callerSession(api.Call{Caller: c}, false)
	if err != nil {
		return ""
	}
	return id
}

// callerSession is the session key the caller names: a Claude toolUseId bound
// within the binding TTL, or a Codex session id; "" when there is none. With
// prune, expired tool-use bindings are removed first.
func (a *Agents) callerSession(c api.Call, prune bool) (string, error) {
	if c.Caller == nil {
		return "", nil
	}
	switch c.Caller.Client {
	case "claude":
		if c.Caller.ToolUseID == "" {
			return "", nil
		}
		cutoff := a.iso(a.o.Clock.Now().Add(-ms(a.o.Contract.Hook.Timing.ToolUseBindingTtlMs)))
		if prune {
			if _, err := a.db().ExecContext(bg, "DELETE FROM tool_use_bindings WHERE created_at <= ?", cutoff); err != nil {
				return "", err
			}
		}
		var id string
		err := a.db().QueryRowContext(bg, "SELECT session_id FROM tool_use_bindings WHERE tool_use_id = ? AND created_at > ?",
			c.Caller.ToolUseID, cutoff).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return id, err
	case "codex":
		if c.Caller.SessionID == "" {
			return "", nil
		}
		return sessionKey("codex", c.Caller.SessionID), nil
	}
	return "", nil
}
