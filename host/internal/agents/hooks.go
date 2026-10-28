package agents

import (
	"context"
	"time"
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

// Hook handles one client hook event (POST /api/hook); it returns what the hook prints, or nil.
func (a *Agents) Hook(ctx context.Context, client string, input map[string]any) (map[string]any, error) {
	a.mu.Lock()
	a.request = ctx
	out, w, err := a.hook(client, input)
	a.request = nil
	a.mu.Unlock()
	if err != nil || w == nil {
		return out, err
	}
	return a.await(ctx, w), nil
}

// hook runs an event with mu held; a returned waiter is a hook to hold open.
func (a *Agents) hook(client string, input map[string]any) (map[string]any, *waiter, error) {
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
		// The client is waiting on its behalf: activity, so a long wait does not let the session go stale.
		if err := a.touch(id, client, "", now); err != nil {
			return nil, nil, err
		}
		// A wait asks again every few minutes: other sessions that went stale meanwhile tell their subscribers.
		if err := a.expireAll(now); err != nil {
			return nil, nil, err
		}
		return nil, a.backgroundWait(id), nil
	}
	if event == a.o.Contract.Hook.WakeResultEvent {
		// A report from the background wait's client, not activity of the conversation.
		dispatchID, _ := input["dispatch_id"].(string)
		ok, _ := input["ok"].(bool)
		return nil, nil, a.wakeResult(id, dispatchID, ok)
	}
	// Any real event of the session follows a wake it was handed: delivered, or overtaken by real input.
	delete(a.dispatches, id)
	cwd, _ := input["cwd"].(string)
	if err := a.touch(id, client, cwd, now); err != nil {
		return nil, nil, err
	}
	if err := a.expireAll(now); err != nil {
		return nil, nil, err
	}
	if event != "Stop" {
		a.cancelBackgroundWaits(id)
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
		return a.stop(id, input)
	case "SessionEnd":
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

func (a *Agents) stop(id string, input map[string]any) (map[string]any, *waiter, error) {
	now := a.o.Clock.Now()
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
		return nil, a.waitForMessages(id), nil
	}
	// A background wait keeps the session reachable: it counts as listening, and the wake lets it check now.
	status := "idle"
	if len(a.backgroundWaits[id]) > 0 {
		status = "listening"
	}
	if err := a.setStatus(id, status); err != nil {
		return nil, nil, err
	}
	subscribers, err := a.fireIdle(id, "idle", now)
	a.wake(append([]string{id}, subscribers...)...)
	return nil, nil, err
}
