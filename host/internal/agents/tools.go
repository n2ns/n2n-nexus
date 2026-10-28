package agents

import (
	"encoding/json"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

type profile struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Title        string `json:"title"`
	Client       string `json:"client"`
	Cwd          string `json:"cwd"`
	Hostname     string `json:"hostname"`
	Platform     string `json:"platform"`
	UTCOffset    int    `json:"utcOffset"`
	Label        string `json:"label"`
	Note         string `json:"note"`
	Status       string `json:"status"`
	LastActiveAt string `json:"lastActiveAt"`
}

func profileOf(s *session) profile {
	return profile{ID: s.ID, Name: s.Name, Title: s.Title, Client: s.Client, Cwd: s.Cwd, Hostname: s.Hostname, Platform: s.Platform, UTCOffset: s.UTCOffset, Label: s.Label, Note: s.Note, Status: s.Status, LastActiveAt: s.LastActiveAt}
}

type recipient struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type sent struct {
	MessageID string    `json:"messageId"`
	To        recipient `json:"to"`
}

// decode reads arguments that already passed the tool's input schema.
func decode(c api.Call, v any) error {
	if err := json.Unmarshal(c.Args, v); err != nil {
		return api.Errorf("Invalid arguments: %v", err)
	}
	return nil
}

// resolve returns the agent session behind a direct-message tool call: Claude
// through the toolUseId its PreToolUse hook bound, Codex through its session id.
func (a *Agents) resolve(c api.Call) (*session, error) {
	now := a.o.Clock.Now()
	var id string
	if c.Caller != nil {
		switch c.Caller.Client {
		case "claude":
			var err error
			if id, err = a.resolveToolUse(c.Caller.ToolUseID, now); err != nil {
				return nil, err
			}
		case "codex":
			id = sessionKey("codex", c.Caller.SessionID)
		}
	}
	noSession := api.Errorf("%s", a.o.Contract.Hook.Texts.NoAgentSessionError)
	if id == "" {
		return nil, noSession
	}
	s, err := getSession(a.db(), id)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, noSession
	}
	if err := a.refresh(id, now); err != nil {
		return nil, err
	}
	if err := a.expireAll(now); err != nil {
		return nil, err
	}
	if err := a.revive(id); err != nil {
		return nil, err
	}
	return getSession(a.db(), id)
}

// kind is what a message asks of its recipient: an answer, and a wake.
type kind struct {
	ExpectsReply bool `json:"expectsReply"`
	Wake         bool `json:"wake"`
}

func (a *Agents) deliver(from, to *session, text string, replyTo *string, notifyWhenIdle bool, k kind) (any, error) {
	if to.ID == from.ID {
		return nil, api.Errorf("You cannot send a message to yourself.")
	}
	now := a.o.Clock.Now()
	id, err := a.addMessage(from.ID, to.ID, text, replyTo, k.ExpectsReply, k.Wake, now)
	if err != nil {
		return nil, err
	}
	if notifyWhenIdle {
		if err := a.subscribeIdle(from.ID, to.ID, now); err != nil {
			return nil, err
		}
	}
	if k.Wake {
		a.wake(to.ID)
	}
	return sent{MessageID: id, To: recipient{ID: to.ID, Name: to.Name, Status: to.Status}}, nil
}

func (a *Agents) toolPeers(c api.Call) (any, error) {
	var args struct {
		IncludeOffline bool `json:"includeOffline"`
	}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	list, err := a.listPeers(self.ID, a.o.Clock.Now())
	if err != nil {
		return nil, err
	}
	peers := []profile{}
	for _, p := range list {
		if args.IncludeOffline || p.Status != "offline" {
			peers = append(peers, profileOf(p))
		}
	}
	return map[string]any{"self": profileOf(self), "peers": peers}, nil
}

func (a *Agents) toolSend(c api.Call) (any, error) {
	args := struct {
		To             string `json:"to"`
		Text           string `json:"text"`
		NotifyWhenIdle bool   `json:"notifyWhenIdle"`
		kind
	}{kind: kind{ExpectsReply: true, Wake: true}}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	to, err := a.findRecipient(args.To)
	if err != nil {
		return nil, err
	}
	if to == nil {
		return nil, api.Errorf("Unknown recipient '%s'. Call peers for session ids and names.", args.To)
	}
	return a.deliver(self, to, args.Text, nil, args.NotifyWhenIdle, args.kind)
}

func (a *Agents) toolReply(c api.Call) (any, error) {
	args := struct {
		MessageID string `json:"messageId"`
		Text      string `json:"text"`
		kind
	}{kind: kind{ExpectsReply: true, Wake: true}}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	original, err := a.getMessage(args.MessageID)
	if err != nil {
		return nil, err
	}
	if original == nil || original.ToID != self.ID {
		return nil, api.Errorf("Message '%s' not found or not sent to you; use a messageId from a notification or read.", args.MessageID)
	}
	sender, err := getSession(a.db(), original.FromID)
	if err != nil {
		return nil, err
	}
	out, err := a.deliver(self, sender, args.Text, &original.ID, false, args.kind)
	if err != nil {
		return nil, err
	}
	// Answered: a message shown in a notification needs no read, and Stop no longer holds the turn for it.
	at := a.iso(a.o.Clock.Now())
	if _, err := a.db().ExecContext(bg, "UPDATE agent_messages SET status = 'read', read_at = ?, notified_at = COALESCE(notified_at, ?) WHERE id = ? AND status = 'unread'", at, at, original.ID); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *Agents) toolRead(c api.Call) (any, error) {
	args := struct {
		Count int `json:"count"`
	}{Count: 10}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	messages, remaining, err := a.readUnread(self.ID, args.Count, a.o.Clock.Now())
	if err != nil {
		return nil, err
	}
	type from struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	type item struct {
		MessageID    string  `json:"messageId"`
		From         from    `json:"from"`
		ReplyTo      *string `json:"replyTo"`
		Text         string  `json:"text"`
		CreatedAt    string  `json:"createdAt"`
		ExpectsReply bool    `json:"expectsReply"`
	}
	items := []item{}
	for _, m := range messages {
		items = append(items, item{MessageID: m.ID, From: from{m.FromID, m.FromName}, ReplyTo: m.ReplyTo, Text: m.Text, CreatedAt: m.CreatedAt, ExpectsReply: m.ExpectsReply})
	}
	return map[string]any{"messages": items, "remaining": remaining}, nil
}

func (a *Agents) toolListen(c api.Call) (any, error) {
	var args struct {
		On bool `json:"on"`
	}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	if err := a.setListening(self.ID, args.On); err != nil {
		return nil, err
	}
	a.wake(self.ID)
	return map[string]any{"listening": args.On}, nil
}

func (a *Agents) toolSetProfile(c api.Call) (any, error) {
	var args struct {
		Name  *string `json:"name"`
		Note  *string `json:"note"`
		Title *string `json:"title"`
		Label *string `json:"label"`
	}
	if err := decode(c, &args); err != nil {
		return nil, err
	}
	if args.Name == nil && args.Note == nil && args.Title == nil && args.Label == nil {
		return nil, api.Errorf("Invalid arguments for set_profile: Pass at least one of name, note, title and label")
	}
	self, err := a.resolve(c)
	if err != nil {
		return nil, err
	}
	s, err := a.updateProfile(self.ID, args.Name, args.Note, args.Title, args.Label)
	if err != nil {
		return nil, err
	}
	return map[string]any{"profile": profileOf(s)}, nil
}
