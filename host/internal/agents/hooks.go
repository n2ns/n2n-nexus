package agents

import (
	"context"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

func sessionKey(client, clientSessionID string) string { return client + ":" + clientSessionID }

// expireAll expires overdue messages (waking the senders that got a
// notice) and sets stale sessions offline, telling their idle subscribers as
// SessionEnd would (mu held).
func (a *Agents) expireAll(now time.Time) error {
	senders, _, err := a.expireMessages(now)
	if err != nil {
		return err
	}
	a.wake(senders...)
	stale, err := a.expireStale(now.Add(-ms(a.o.Contract.Hook.Timing.StaleSessionMs)))
	if err != nil {
		return err
	}
	for _, id := range stale {
		subscribers, err := a.fireIdle(id, "offline", now)
		if err != nil {
			return err
		}
		a.wake(subscribers...)
	}
	return nil
}

// revive: a stale session that acts again (a tool call) is working; one that
// ended stays offline until its next prompt (mu held).
func (a *Agents) revive(id string) error {
	s, err := getSession(a.db(), id)
	if err != nil || s == nil || s.Status != "offline" {
		return err
	}
	return a.setStatus(id, "working")
}

// machineOf reads where the session runs from a hook event's input: every
// event of the conversation carries machine {hostname, platform, environment, utcOffset}.
func (a *Agents) machineOf(input map[string]any) (*machine, error) {
	raw, _ := input["machine"].(map[string]any)
	hostname, _ := raw["hostname"].(string)
	hostname = oneLine(hostname)
	platform, _ := raw["platform"].(string)
	environment, hasEnvironment := raw["environment"].(string)
	environment = oneLine(environment)
	offset, isNumber := raw["utcOffset"].(float64)
	if hostname == "" || !knownPlatform(platform) || !hasEnvironment || !isNumber || offset != float64(int(offset)) || offset < -1440 || offset > 1440 {
		return nil, api.Errorf("Invalid hook request: input.machine must be {hostname, platform: darwin | linux | wsl | win32, environment, utcOffset: minutes from UTC}; upgrade n2n-nexus to the host's version")
	}
	if r := []rune(environment); len(r) > a.o.Contract.Hook.Limits.MaxHostnameChars {
		environment = string(r[:a.o.Contract.Hook.Limits.MaxHostnameChars])
	}
	if r := []rune(hostname); len(r) > a.o.Contract.Hook.Limits.MaxHostnameChars {
		hostname = string(r[:a.o.Contract.Hook.Limits.MaxHostnameChars])
	}
	return &machine{Hostname: hostname, Platform: platform, Environment: environment, UTCOffset: int(offset)}, nil
}

// piMachineKey is the machine a pi process ID belongs to (process IDs are per machine, and per
// WSL distribution), from the hook's input.machine or a pi caller's machine, cut and joined
// the same way as machineOf, so that both give the same key.
func (a *Agents) piMachineKey(hostname, platform, environment string) string {
	limit := a.o.Contract.Hook.Limits.MaxHostnameChars
	clip := func(s string) string {
		s = oneLine(s)
		if r := []rune(s); len(r) > limit {
			s = string(r[:limit])
		}
		return s
	}
	return clip(hostname) + "\n" + platform + "\n" + clip(environment)
}

// Hook handles one client hook event (POST /api/hook); it returns what the hook prints, or nil.
func (a *Agents) Hook(ctx context.Context, client string, input map[string]any) (map[string]any, error) {
	a.mu.Lock()
	out, w, err := a.hook(ctx, client, input)
	a.mu.Unlock()
	if err != nil || w == nil {
		return out, err
	}
	return a.await(ctx, w), nil
}

// hook runs an event with mu held; a returned waiter is a hook to hold open.
func (a *Agents) hook(ctx context.Context, client string, input map[string]any) (map[string]any, *waiter, error) {
	clientSession, _ := input["session_id"].(string)
	if clientSession == "" {
		return nil, nil, nil
	}
	id := sessionKey(client, clientSession)
	event, _ := input["hook_event_name"].(string)
	now := a.o.Clock.Now()
	if event == a.o.Contract.Hook.BackgroundWaitEvent {
		s, err := getSession(a.db(), id)
		if err != nil || s == nil {
			return nil, nil, err
		}
		if s.Status == "offline" {
			// Another request may have expired this idle session before its
			// wait reconnected after downtime. The wait is evidence it survived.
			// Explicit SessionEnd and expired working sessions remain offline.
			if s.StaleFrom != "idle" {
				return nil, nil, nil
			}
			if err := a.setStatus(id, "idle"); err != nil {
				return nil, nil, err
			}
		}
		// The client is waiting on its behalf: activity, so a long wait does not let the session go stale.
		// Not for a working session: its activity is its own events, and a wait is all that
		// touches a session whose Stop was lost, which must go stale like any other.
		if s.Status != "working" {
			if err := a.touch(id, client, "", nil, now); err != nil {
				return nil, nil, err
			}
		}
		// A wait asks again every few minutes: other sessions that went stale meanwhile tell their subscribers.
		if err := a.expireAll(now); err != nil {
			return nil, nil, err
		}
		return nil, a.backgroundWait(ctx, id), nil
	}
	if event == a.o.Contract.Hook.WakeResultEvent {
		// A report from the background wait's client, not activity of the conversation.
		dispatchID, _ := input["dispatch_id"].(string)
		ok, _ := input["ok"].(bool)
		return nil, nil, a.wakeResult(id, dispatchID, ok)
	}
	// Any real event of the session follows a wake it was handed: delivered, or overtaken by real input.
	delete(a.dispatches, id)
	m, err := a.machineOf(input)
	if err != nil {
		return nil, nil, err
	}
	cwd, _ := input["cwd"].(string)
	cwd = oneLine(cwd)
	if err := a.touch(id, client, cwd, m, now); err != nil {
		return nil, nil, err
	}
	// A pi process names its own process ID with each event: tool calls it makes later are attributed by it.
	if client == "pi" {
		if pid, _ := input["client_pid"].(float64); pid >= 1 && pid == float64(int(pid)) {
			if _, err := a.db().ExecContext(bg, "INSERT OR REPLACE INTO pi_client_pids (machine, client_pid, session_id, updated_at) VALUES (?, ?, ?, ?)",
				a.piMachineKey(m.Hostname, m.Platform, m.Environment), int(pid), id, a.iso(now)); err != nil {
				return nil, nil, err
			}
		}
	}
	// Before the expiry check: what that finds for this session reaches the event itself,
	// not a background wait that the event ends anyway.
	if event != "Stop" {
		a.cancelBackgroundWaits(id)
	}
	if err := a.expireAll(now); err != nil {
		return nil, nil, err
	}
	// The client reports the conversation's title with these events only.
	if event == "SessionStart" || event == "UserPromptSubmit" || event == "Stop" {
		if title, _ := input["title"].(string); title != "" {
			if err := a.setClientTitle(id, title); err != nil {
				return nil, nil, err
			}
		}
	}

	switch event {
	case "SessionStart":
		if err := a.setStatus(id, "idle"); err != nil {
			return nil, nil, err
		}
		text, err := a.introduce(id)
		return contextOutput("SessionStart", text), nil, err
	case "UserPromptSubmit":
		delete(a.toolAnnounced, id)
		delete(a.toolMeetings, id)
		woken := a.userPrompted(id, now)
		if err := a.setStatus(id, "working"); err != nil {
			return nil, nil, err
		}
		// The turn a wake began got the announcement as its prompt: only what arrived since.
		var text string
		var err error
		if woken {
			text, err = a.notifyFresh(id, a.o.Contract.Hook.Texts.NotifyClosing, markNoReply)
		} else {
			text, err = a.notifyAll(id, a.o.Contract.Hook.Texts.NotifyClosing)
		}
		return contextOutput("UserPromptSubmit", text), nil, err
	case "PreToolUse":
		if toolUseID, _ := input["tool_use_id"].(string); toolUseID != "" {
			if err := a.bindToolUse(toolUseID, id, now); err != nil {
				return nil, nil, err
			}
		}
		return nil, nil, a.revive(id)
	case "PostToolUse":
		if err := a.setStatus(id, "working"); err != nil {
			return nil, nil, err
		}
		// A tool call can be a sub-agent's, whose context the conversation never sees: nothing is marked read.
		text, err := a.notifyFresh(id, a.o.Contract.Hook.Texts.NotifyClosing, markNone)
		return contextOutput("PostToolUse", text), nil, err
	case "Stop":
		return a.stop(ctx, id, input)
	case "SessionEnd":
		delete(a.toolAnnounced, id)
		delete(a.toolMeetings, id)
		if err := a.setStatus(id, "offline"); err != nil {
			return nil, nil, err
		}
		if err := a.setListening(id, false); err != nil {
			return nil, nil, err
		}
		subscribers, err := a.fireIdle(id, "offline", now)
		a.wake(append([]string{id}, subscribers...)...)
		return nil, nil, err
	}
	return nil, nil, nil
}

func (a *Agents) stop(ctx context.Context, id string, input map[string]any) (map[string]any, *waiter, error) {
	now := a.o.Clock.Now()
	toolAnnounced := a.toolAnnounced[id]
	toolMeetings := a.toolMeetings[id]
	delete(a.toolAnnounced, id)
	delete(a.toolMeetings, id)
	if active, _ := input["stop_hook_active"].(bool); !active {
		// Past the automatic-turn limit, direct messages wait for the user; meeting news still holds the Stop.
		b, err := a.gather(id, true, !a.autoTurnAllowed(id))
		if err != nil {
			return nil, nil, err
		}
		if b.wakes() {
			text, _, err := a.continueWith(id, b, "unread", a.o.Contract.Hook.Texts.StopClosing)
			if err != nil {
				return nil, nil, err
			}
			if err := a.setStatus(id, "working"); err != nil {
				return nil, nil, err
			}
			return blockOutput(text), nil, nil
		}
	} else if len(toolAnnounced) > 0 || len(toolMeetings) > 0 {
		// The Stop of a continued turn holds nothing, so the messages that only tool calls announced
		// in it and that are still unread count as not announced: the wait below or the background
		// wait delivers them, once (that announcement is not a tool call's).
		if err := a.unmarkUnread(id, toolAnnounced, toolMeetings); err != nil {
			return nil, nil, err
		}
	}
	s, err := getSession(a.db(), id)
	if err != nil {
		return nil, nil, err
	}
	if s.Listening {
		if err := a.setStatus(id, "listening"); err != nil {
			return nil, nil, err
		}
		subscribers, err := a.fireIdle(id, "idle", now)
		a.wake(subscribers...)
		if err != nil {
			return nil, nil, err
		}
		return nil, a.waitForMessages(ctx, id), nil
	}
	// A background wait keeps the session reachable: it counts as listening, and the wake lets it check now.
	status := "idle"
	if len(a.backgroundWaits(id)) > 0 {
		status = "listening"
	}
	if err := a.setStatus(id, status); err != nil {
		return nil, nil, err
	}
	subscribers, err := a.fireIdle(id, "idle", now)
	a.wake(append([]string{id}, subscribers...)...)
	return nil, nil, err
}
