// Package agents implements the conversations: agent sessions created by the
// client hooks (POST /api/hook), the direct-message tools (peers, send, read,
// reply, listen, set_profile), the listening / background-wait state machine
// and their tables (store/migrations/0002_agents.sql).
//
// Agents is the coordinator of one host: it holds every piece of in-memory
// state (held listening Stops, background waits, automatic-turn counts, wake
// times) behind one mutex. Each hook and tool call runs under it, and so does
// every wait's check, which wake runs synchronously like the event emitter of
// the TypeScript daemon: whoever stores a message or notice delivers it to a
// waiting hook before releasing the lock.
package agents

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Options configure the agents.
type Options struct {
	Store    *store.Store
	Clock    clock.Clock
	Contract *protocol.Contract
	Logger   *log.Logger
	// ListenWait is how long a listening Stop hook and one background-wait round are held open.
	ListenWait time.Duration
	// MaxAutoTurns limits automatic turns between user prompts; 0 = no limit.
	MaxAutoTurns int
}

// RetentionDays: read or expired direct messages and delivered notices are kept this long.
const RetentionDays = 30

// Agents is the conversation state of one host.
type Agents struct {
	o Options

	mu     sync.Mutex
	closed bool
	// request is the context of the hook being handled (set with mu held, by Hook): a
	// wait whose client is already gone ends without its first check, so nothing is
	// marked delivered that nobody received.
	request context.Context
	closing chan struct{}
	// waiters are the held hooks per session, in the order they started.
	waiters map[string][]*waiter
	// listeningStops: sessions whose listening Stop hook waits; it delivers before any background wait.
	listeningStops map[string]bool
	// backgroundWaits: sessions with background waits in progress.
	backgroundWaits map[string]map[*waiter]bool
	// autoTurns: automatic turns per session since its user last prompted.
	autoTurns map[string]int
	// wokenAt: when a background wait last woke each session, to tell the woken turn's prompt from the user's.
	wokenAt map[string]time.Time
	// dispatches: the last wake per session whose delivery the client has not reported yet
	// (WakeResult) and that no real hook event of the session has followed.
	dispatches map[string]*dispatch
}

// dispatch is one wake handed to a client (backgroundWait), kept so that a
// failed delivery can be undone: what the wake marked notified, and the wake
// time it replaced.
type dispatch struct {
	id         string
	messageIDs []string
	noticeIDs  []int64
	// members are the session's meeting notification states before this wake.
	members []memberState
	// counted: the wake counted an automatic turn.
	counted bool
	// prevWokenAt is the session's wokenAt before this wake (zero: none).
	prevWokenAt time.Time
}

// waiter is one held hook request. Its functions run with Agents.mu held.
type waiter struct {
	session   string
	check     func()
	onTimeout func()
	onAbort   func()
	finished  bool
	out       map[string]any
	done      chan struct{}
}

// New returns the agents of a host whose database was just opened. No wait is
// held yet, so sessions a previous host left listening become idle (and can go stale).
func New(o Options) (*Agents, error) {
	if o.Clock == nil {
		o.Clock = clock.System{}
	}
	if o.Logger == nil {
		o.Logger = log.Default()
	}
	if _, err := o.Store.DB.Exec("UPDATE agent_sessions SET status = 'idle' WHERE status = 'listening'"); err != nil {
		return nil, fmt.Errorf("reset listening sessions: %w", err)
	}
	return &Agents{
		o:               o,
		closing:         make(chan struct{}),
		waiters:         map[string][]*waiter{},
		listeningStops:  map[string]bool{},
		backgroundWaits: map[string]map[*waiter]bool{},
		autoTurns:       map[string]int{},
		wokenAt:         map[string]time.Time{},
		dispatches:      map[string]*dispatch{},
	}, nil
}

// Register adds the direct-message tools and the hook handler to srv.
func (a *Agents) Register(srv *api.Server) {
	srv.Register("peers", a.locked(a.toolPeers))
	srv.Register("send", a.locked(a.toolSend))
	srv.Register("read", a.locked(a.toolRead))
	srv.Register("reply", a.locked(a.toolReply))
	srv.Register("listen", a.locked(a.toolListen))
	srv.Register("set_profile", a.locked(a.toolSetProfile))
	srv.SetHook(a.Hook)
}

func (a *Agents) locked(fn api.ToolFunc) api.ToolFunc {
	return func(c api.Call) (any, error) {
		a.mu.Lock()
		defer a.mu.Unlock()
		return fn(c)
	}
}

// OnlineSessions counts the sessions that are not offline; an idle or working
// session without activity past the stale limit counts as offline, as the next
// hook would mark it.
func (a *Agents) OnlineSessions() (int, error) {
	before := a.o.Clock.Now().Add(-ms(a.o.Contract.Hook.Timing.StaleSessionMs))
	var n int
	err := a.db().QueryRowContext(bg, "SELECT COUNT(*) FROM agent_sessions WHERE status != 'offline' AND NOT (status IN ('idle', 'working') AND last_active_at < ?)", a.iso(before)).Scan(&n)
	return n, err
}

// Health is the agents' part of GET /health: {"sessions": {"online": n}}.
func (a *Agents) Health() map[string]any {
	n, err := a.OnlineSessions()
	if err != nil {
		a.o.Logger.Printf("health: count sessions: %v", err)
		return nil
	}
	return map[string]any{"sessions": map[string]any{"online": n}}
}

// Close ends every held wait (host shutting down); later waits end at once.
func (a *Agents) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		a.closed = true
		close(a.closing)
	}
}

// Maintain expires unread messages past their expiry (telling the senders),
// deletes read or expired direct messages and delivered notices after
// RetentionDays and tool-use bindings past their TTL; it returns a log line or "".
func (a *Agents) Maintain(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.o.Clock.Now()
	senders, expired, err := a.expireMessages(now)
	if err != nil {
		return "", err
	}
	a.wake(senders...)
	cutoff := a.iso(now.AddDate(0, 0, -RetentionDays))
	bindingCutoff := a.iso(now.Add(-ms(a.o.Contract.Hook.Timing.ToolUseBindingTtlMs)))
	var messages, notices, bindings int64
	err = a.o.Store.Tx(ctx, func(tx *sql.Tx) error {
		old := "(status = 'read' AND read_at < ?) OR (status = 'expired' AND expires_at < ?)"
		// Replies keep their text when the message they answer goes.
		if _, err := tx.ExecContext(ctx, "UPDATE agent_messages SET reply_to = NULL WHERE reply_to IN (SELECT id FROM agent_messages WHERE "+old+")", cutoff, cutoff); err != nil {
			return err
		}
		var err error
		if messages, err = affected(tx.ExecContext(ctx, "DELETE FROM agent_messages WHERE "+old, cutoff, cutoff)); err != nil {
			return err
		}
		if notices, err = affected(tx.ExecContext(ctx, "DELETE FROM agent_notices WHERE notified_at IS NOT NULL AND notified_at < ?", cutoff)); err != nil {
			return err
		}
		bindings, err = affected(tx.ExecContext(ctx, "DELETE FROM tool_use_bindings WHERE created_at <= ?", bindingCutoff))
		return err
	})
	if err != nil {
		return "", err
	}
	if expired == 0 && messages == 0 && notices == 0 && bindings == 0 {
		return "", nil
	}
	return fmt.Sprintf("agents: %d messages expired; deleted %d messages, %d notices, %d tool-use bindings", expired, messages, notices, bindings), nil
}

func affected(r sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

// wake runs the checks of every wait held for the sessions (mu held).
func (a *Agents) wake(ids ...string) {
	for _, id := range ids {
		for _, w := range append([]*waiter(nil), a.waiters[id]...) {
			if !w.finished {
				w.check()
			}
		}
	}
}

// startWait registers w and runs its first check (mu held).
func (a *Agents) startWait(w *waiter) {
	w.done = make(chan struct{})
	a.waiters[w.session] = append(a.waiters[w.session], w)
	if a.request != nil && a.request.Err() != nil {
		w.onAbort()
		return
	}
	if a.closed {
		w.onTimeout()
		return
	}
	w.check()
}

// endWait records the output and unregisters w (mu held); it reports whether w was still waiting.
func (a *Agents) endWait(w *waiter, out map[string]any) bool {
	if w.finished {
		return false
	}
	w.finished = true
	w.out = out
	list := a.waiters[w.session]
	for i, x := range list {
		if x == w {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(a.waiters, w.session)
	} else {
		a.waiters[w.session] = list
	}
	close(w.done)
	return true
}

// await blocks (without mu) until w ends: delivered by a check, timed out, the
// client gone or the host closing.
func (a *Agents) await(ctx context.Context, w *waiter) map[string]any {
	timer := time.NewTimer(a.o.ListenWait)
	defer timer.Stop()
	var end func()
	select {
	case <-w.done:
	case <-timer.C:
		end = w.onTimeout
	case <-ctx.Done():
		end = w.onAbort
	case <-a.closing:
		end = w.onTimeout
	}
	if end != nil {
		a.mu.Lock()
		if !w.finished {
			end()
		}
		a.mu.Unlock()
	}
	<-w.done
	return w.out
}

func (a *Agents) logErr(what string, err error) {
	if err != nil {
		a.o.Logger.Printf("agents: %s: %v", what, err)
	}
}

// waitForMessages holds a listening Stop hook: until something not notified
// yet arrives (then the stop is blocked with it), the wait runs out, or the
// hook's client goes away (mu held).
func (a *Agents) waitForMessages(sessionID string) *waiter {
	a.listeningStops[sessionID] = true
	w := &waiter{session: sessionID}
	finish := func(out map[string]any) {
		if a.endWait(w, out) {
			delete(a.listeningStops, sessionID)
		}
	}
	stopWaiting := func() {
		if w.finished {
			return
		}
		a.logErr("listening stop", a.setStatusIf(sessionID, "listening", "idle"))
		finish(nil)
		a.wake(sessionID) // a background wait takes over
	}
	w.onTimeout, w.onAbort = stopWaiting, stopWaiting
	w.check = func() {
		if w.finished {
			return
		}
		s, err := getSession(a.db(), sessionID)
		if err != nil {
			a.logErr("listening stop", err)
			return
		}
		// SessionEnd (or listen off) during the wait: nobody will act on a block any more.
		// stopWaiting sets idle only while still listening, so SessionEnd stays offline.
		if s == nil || !s.Listening {
			stopWaiting()
			return
		}
		// Past the automatic-turn limit, direct messages wait for the user; meeting news still continues the session.
		b, err := a.gather(sessionID, false, !a.autoTurnAllowed(sessionID))
		if err != nil || !b.wakes() {
			a.logErr("listening stop", err)
			return
		}
		text, _, err := a.continueWith(sessionID, b, "new", a.o.Contract.Hook.Texts.StopClosing)
		if err != nil {
			a.logErr("listening stop", err)
			return
		}
		a.logErr("listening stop", a.setStatus(sessionID, "working"))
		finish(blockOutput(text))
	}
	a.startWait(w)
	return w
}

// backgroundWait (the BackgroundWait pseudo event): the session counts as
// listening, and the wait returns {wake, dispatchId} with what was not notified
// yet as soon as there is any (the client reports the delivery with a
// WakeResult naming dispatchId, see wakeResult), {timeout: true} when the wait runs out (the client asks
// again) and null when the session became active or the client went away.
// While a listening Stop hook waits, that hook delivers instead. It never
// delivers while the session is working: the wait starts alongside Stop, which
// announces what is unread at the end of the turn itself, and Stop wakes the
// wait again once the turn has ended (mu held).
func (a *Agents) backgroundWait(sessionID string) *waiter {
	w := &waiter{session: sessionID}
	waits := a.backgroundWaits[sessionID]
	if waits == nil {
		waits = map[*waiter]bool{}
		a.backgroundWaits[sessionID] = waits
	}
	waits[w] = true
	finish := func(out map[string]any) {
		if !a.endWait(w, out) {
			return
		}
		delete(waits, w)
		if len(waits) == 0 {
			delete(a.backgroundWaits, sessionID)
		}
		// Nothing waits for the session any more: it stops counting as listening (even with listen on).
		_, woke := out["wake"]
		if !woke && len(a.backgroundWaits[sessionID]) == 0 && !a.listeningStops[sessionID] {
			a.logErr("background wait", a.setStatusIf(sessionID, "listening", "idle"))
		}
	}
	stopWaiting := func() { finish(nil) }
	w.onAbort = stopWaiting
	w.onTimeout = func() { finish(map[string]any{"timeout": true}) }
	w.check = func() {
		if w.finished {
			return
		}
		s, err := getSession(a.db(), sessionID)
		if err != nil {
			a.logErr("background wait", err)
			return
		}
		if s == nil || s.Status == "offline" {
			stopWaiting()
			return
		}
		if s.Status == "working" || a.listeningStops[sessionID] {
			return
		}
		if s.Status == "idle" {
			a.logErr("background wait", a.setStatus(sessionID, "listening"))
		}
		// Past the automatic-turn limit, direct messages wait for the user; meeting news still wakes the session.
		b, err := a.gather(sessionID, false, !a.autoTurnAllowed(sessionID))
		if err != nil || !b.wakes() {
			a.logErr("background wait", err)
			return
		}
		d := &dispatch{id: newDispatchID(), prevWokenAt: a.wokenAt[sessionID], counted: b.counts()}
		text, members, err := a.continueWith(sessionID, b, "new", a.o.Contract.Hook.Texts.NotifyClosing)
		if err != nil {
			a.logErr("background wait", err)
			return
		}
		d.members = members
		for _, m := range b.messages {
			d.messageIDs = append(d.messageIDs, m.ID)
		}
		for _, n := range b.notices {
			d.noticeIDs = append(d.noticeIDs, n.ID)
		}
		a.dispatches[sessionID] = d
		a.logErr("background wait", a.setStatus(sessionID, "working"))
		a.wokenAt[sessionID] = a.o.Clock.Now()
		finish(map[string]any{"wake": text, "dispatchId": d.id})
	}
	a.startWait(w)
	return w
}

func newDispatchID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b) // never fails (crypto/rand)
	return hex.EncodeToString(b)
}

// wakeResult (the WakeResult pseudo event): the client reports whether it
// delivered the wake dispatchID. A failed delivery of the session's pending
// wake is undone: its messages and notices count as not notified again, the
// session leaves working (listening while another wait holds it, else idle),
// and the automatic turn and wake time it counted are taken back; any wait
// still held is woken to deliver it again. A success, an unknown id or a wake
// that a real hook event of the session already followed changes nothing
// (mu held).
func (a *Agents) wakeResult(sessionID, dispatchID string, ok bool) error {
	d := a.dispatches[sessionID]
	if d == nil || dispatchID == "" || d.id != dispatchID {
		return nil
	}
	delete(a.dispatches, sessionID)
	if ok {
		return nil
	}
	if err := a.unmarkNotified(d.messageIDs, d.noticeIDs); err != nil {
		return err
	}
	if err := a.restoreMembers(sessionID, d.members); err != nil {
		return err
	}
	if d.counted {
		if n := a.autoTurns[sessionID] - 1; n > 0 {
			a.autoTurns[sessionID] = n
		} else {
			delete(a.autoTurns, sessionID)
		}
	}
	if d.prevWokenAt.IsZero() {
		delete(a.wokenAt, sessionID)
	} else {
		a.wokenAt[sessionID] = d.prevWokenAt
	}
	status := "idle"
	if len(a.backgroundWaits[sessionID]) > 0 || a.listeningStops[sessionID] {
		status = "listening"
	}
	if err := a.setStatusIf(sessionID, "working", status); err != nil {
		return err
	}
	a.wake(sessionID)
	return nil
}

// cancelBackgroundWaits: the session became active again; its background waits
// end and the client handles messages itself (mu held).
func (a *Agents) cancelBackgroundWaits(sessionID string) {
	for w := range a.backgroundWaits[sessionID] {
		w.onAbort()
	}
}

// ---------------------------------------------------------------------------
// Automatic turns
// ---------------------------------------------------------------------------

func (a *Agents) autoTurnAllowed(sessionID string) bool {
	return a.o.MaxAutoTurns == 0 || a.autoTurns[sessionID] < a.o.MaxAutoTurns
}

// autoTurn counts an automatic turn for text (a notification that continues the session) and says so in it.
func (a *Agents) autoTurn(sessionID, text string) string {
	n := a.autoTurns[sessionID] + 1
	a.autoTurns[sessionID] = n
	if a.o.MaxAutoTurns == 0 {
		return text
	}
	return fmt.Sprintf("%s\n%s Automatic turn %d of %d since your user's last prompt; after turn %d, messages wait until your user prompts again.",
		text, a.o.Contract.Hook.Texts.NoticePrefix, n, a.o.MaxAutoTurns, a.o.MaxAutoTurns)
}

// userPrompted: a prompt resets the count, unless it starts the turn a wake
// just began; it reports whether it does.
func (a *Agents) userPrompted(sessionID string, now time.Time) bool {
	woken, ok := a.wokenAt[sessionID]
	delete(a.wokenAt, sessionID)
	if !ok || now.Sub(woken) > ms(a.o.Contract.Hook.Timing.WakePromptWindowMs) {
		delete(a.autoTurns, sessionID)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

// batch is what one notification announces.
type batch struct {
	// messages: unread direct messages not announced yet, listed in full.
	messages []*message
	// earlier: unread direct messages announced before, only counted.
	earlier []*message
	notices []notice
	news    []meetingNews
}

func (b batch) empty() bool {
	return len(b.messages) == 0 && len(b.earlier) == 0 && len(b.notices) == 0 && len(b.news) == 0
}

// wakes: the batch may wake the session or hold its Stop: a direct message
// that wakes, a notice that is not from a meeting the session takes part in
// asynchronously, or news of a meeting it takes part in actively.
func (b batch) wakes() bool {
	for _, m := range append(append([]*message(nil), b.messages...), b.earlier...) {
		if m.Wake {
			return true
		}
	}
	for _, n := range b.news {
		if n.active {
			return true
		}
	}
	for _, n := range b.notices {
		if n.Wakes {
			return true
		}
	}
	return false
}

// counts: delivering the batch is an automatic turn (maxAutoTurns): it has
// direct messages or notices that do not come from a meeting.
func (b batch) counts() bool {
	if len(b.messages) > 0 || len(b.earlier) > 0 {
		return true
	}
	for _, n := range b.notices {
		if n.MeetingID == "" {
			return true
		}
	}
	return false
}

// gather collects what to announce to a session: direct messages not announced
// yet (with all, the earlier unread ones too, counted), pending notices and
// meeting news. With capped (the automatic-turn limit is reached), direct
// messages and their notices are left for the user's next prompt.
func (a *Agents) gather(sessionID string, all, capped bool) (batch, error) {
	var b batch
	unreadMessages, err := unread(a.db(), sessionID, false)
	if err != nil {
		return b, err
	}
	notices, err := a.pendingNotices(sessionID)
	if err != nil {
		return b, err
	}
	if b.news, err = a.news(sessionID); err != nil {
		return b, err
	}
	for _, n := range notices {
		if !capped || n.MeetingID != "" {
			b.notices = append(b.notices, n)
		}
	}
	if capped {
		return b, nil
	}
	for _, m := range unreadMessages {
		switch {
		case m.NotifiedAt == nil:
			b.messages = append(b.messages, m)
		case all:
			b.earlier = append(b.earlier, m)
		}
	}
	return b, nil
}

// readMark says which of the messages an announcement shows whole it also marks read.
type readMark int

const (
	// markNone: a tool call's context can reach a sub-agent only, so every message stays unread for read.
	markNone readMark = iota
	// markNoReply: a prompt's context reaches the conversation; a message that needs no reply is done once shown.
	markNoReply
	// markShown: the text drives the turn (it wakes the session or holds its Stop), so what it shows whole is read.
	markShown
)

// announce builds the notification text of a batch and marks it notified.
// Each listed message is shown with its text, all texts together cut to the
// contract's notifyTextChars; mark says which of those shown whole are also
// marked read. The others, and a message cut or not listed, stay unread until
// read returns them or reply answers them, so Stop holds the turn for them.
// closing ends the direct-message part when a message expects a reply.
func (a *Agents) announce(sessionID string, b batch, label, closing string, mark readMark) (string, error) {
	h := a.o.Contract.Hook
	limit := h.Limits.NotifyListLimit
	var lines []string
	var shown []string // messages shown whole, marked read
	rest := false      // a message is cut or not listed
	if n := len(b.messages); n > 0 {
		plural := "s"
		if n == 1 {
			plural = ""
		}
		lines = append(lines, fmt.Sprintf("%s %d %s direct message%s:", h.Texts.NoticePrefix, n, label, plural))
		budget := h.Limits.NotifyTextChars
		for i, m := range b.messages {
			if i == limit {
				break
			}
			lines = append(lines, fmt.Sprintf(h.Texts.MessageHeader, m.ID, displayName(m.FromName, m.FromMachine, m.FromTitle), m.FromID, m.CreatedAt))
			if m.ReplyTo != nil {
				lines = append(lines, fmt.Sprintf(h.Texts.MessageReplyTo, *m.ReplyTo))
			}
			text := cutUnits(m.Text, budget)
			budget -= unitLen(text)
			lines = append(lines, text)
			if len(text) < len(m.Text) {
				rest = true
				lines = append(lines, fmt.Sprintf(h.Texts.MessageCut, unitLen(text), unitLen(m.Text)))
			} else if mark == markShown || (mark == markNoReply && !m.ExpectsReply) {
				shown = append(shown, m.ID)
			}
			lines = append(lines, fmt.Sprintf(h.Texts.MessageEnd, m.ID))
			if m.ExpectsReply {
				lines = append(lines, fmt.Sprintf(h.Texts.ReplyInstruction, m.ID))
			} else {
				lines = append(lines, h.Texts.NoReplyMark)
			}
		}
		if n > limit {
			rest = true
			lines = append(lines, fmt.Sprintf("- ...and %d more", n-limit))
		}
	}
	if len(b.earlier) > 0 {
		lines = append(lines, h.Texts.NoticePrefix+" "+fmt.Sprintf(h.Texts.EarlierUnread, len(b.earlier)))
	}
	if len(b.notices) > 0 {
		if len(lines) > 0 {
			lines = append(lines, "Notices:")
		} else {
			lines = append(lines, h.Texts.NoticePrefix+" Notices:")
		}
		for _, n := range b.notices {
			lines = append(lines, "- "+n.Text)
		}
	}
	if len(b.messages) > 0 || len(b.earlier) > 0 {
		reply := false
		for _, m := range append(append([]*message(nil), b.messages...), b.earlier...) {
			reply = reply || m.ExpectsReply
		}
		if reply {
			lines = append(lines, h.Texts.MessageTrustNote+" "+closing)
			// Claude Code names an MCP tool mcp__<server>__<tool>; the full name saves the model a lookup.
			if s, err := getSession(a.db(), sessionID); err != nil {
				return "", err
			} else if s != nil && s.Client == "claude" {
				lines = append(lines, fmt.Sprintf(h.Texts.ReplyTool, "mcp__"+h.MCPServerName+"__reply"))
			}
		} else {
			lines = append(lines, h.Texts.MessageInfoNote)
		}
		if rest {
			lines = append(lines, h.Texts.ReadRest)
		}
	}
	for _, n := range b.news {
		lines = append(lines, a.newsLine(n))
	}
	if len(b.news) > 0 {
		lines = append(lines, h.Texts.MeetingClosing)
	}
	now := a.iso(a.o.Clock.Now())
	err := a.tx(func(tx *sql.Tx) error {
		for _, m := range b.messages {
			if _, err := tx.ExecContext(bg, "UPDATE agent_messages SET notified_at = ? WHERE id = ? AND notified_at IS NULL", now, m.ID); err != nil {
				return err
			}
		}
		for _, id := range shown {
			if _, err := tx.ExecContext(bg, "UPDATE agent_messages SET status = 'read', read_at = ? WHERE id = ? AND status = 'unread'", now, id); err != nil {
				return err
			}
		}
		for _, n := range b.notices {
			if _, err := tx.ExecContext(bg, "UPDATE agent_notices SET notified_at = ? WHERE id = ? AND notified_at IS NULL", now, n.ID); err != nil {
				return err
			}
		}
		return a.markMeetingsNotified(tx, sessionID, b.news)
	})
	if err != nil {
		return "", err
	}
	return strings.Join(lines, "\n"), nil
}

// notifyAll: for a prompt, every unread message (the earlier ones counted), pending notices and meeting news; "" when there are none.
func (a *Agents) notifyAll(sessionID, closing string) (string, error) {
	return a.notifyWith(sessionID, true, "unread", closing, markNoReply)
}

// notifyFresh: for a tool call, or the prompt of a woken turn, what was not announced yet, or "" when nothing is new.
func (a *Agents) notifyFresh(sessionID, closing string, mark readMark) (string, error) {
	return a.notifyWith(sessionID, false, "new", closing, mark)
}

func (a *Agents) notifyWith(sessionID string, all bool, label, closing string, mark readMark) (string, error) {
	b, err := a.gather(sessionID, all, false)
	if err != nil || b.empty() {
		return "", err
	}
	return a.announce(sessionID, b, label, closing, mark)
}

// continueWith announces a batch that wakes the session or holds its Stop: it
// counts the meeting wakes and, for direct messages, the automatic turn. It
// returns the text and the meeting states before (mu held).
func (a *Agents) continueWith(sessionID string, b batch, label, closing string) (string, []memberState, error) {
	before, err := a.countMeetingWakes(sessionID, b.news)
	if err != nil {
		return "", nil, err
	}
	text, err := a.announce(sessionID, b, label, closing, markShown)
	if err != nil {
		return "", nil, err
	}
	if b.counts() {
		text = a.autoTurn(sessionID, text)
	}
	return text, before, nil
}

// introduce: the SessionStart introduction, who this session is and which other sessions are online now.
func (a *Agents) introduce(sessionID string) (string, error) {
	h := a.o.Contract.Hook
	self, err := getSession(a.db(), sessionID)
	if err != nil {
		return "", err
	}
	peers, err := a.listPeers(sessionID, a.o.Clock.Now())
	if err != nil {
		return "", err
	}
	var online []*session
	for _, p := range peers {
		if p.Status != "offline" {
			online = append(online, p)
		}
	}
	lines := []string{fmt.Sprintf("%s This conversation is %s (%s) on n2n-nexus, where AI sessions can message each other.", h.Texts.NoticePrefix, self.Name, self.ID)}
	if n := len(online); n == 0 {
		lines = append(lines, "No other AI sessions are online.")
	} else {
		verb := "s are"
		if n == 1 {
			verb = " is"
		}
		lines = append(lines, fmt.Sprintf("%d other AI session%s online:", n, verb))
		for i, p := range online {
			if i == h.Limits.NotifyListLimit {
				break
			}
			line := fmt.Sprintf("- %s (%s), %s, %s", displayName(p.Name, p.machineName(), p.Title), p.ID, p.Client, p.Status)
			if p.Cwd != "" {
				line += ", " + p.Cwd
			}
			if p.Note != "" {
				line += ": " + p.Note
			}
			lines = append(lines, line)
		}
		if n > h.Limits.NotifyListLimit {
			lines = append(lines, fmt.Sprintf("- ...and %d more", n-h.Limits.NotifyListLimit))
		}
		lines = append(lines, h.Texts.StatusNote)
	}
	lines = append(lines, h.Texts.SessionStartClosing, h.Texts.CollaborationRules)
	return strings.Join(lines, "\n"), nil
}

func contextOutput(event, text string) map[string]any {
	if text == "" {
		return nil
	}
	return map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": event, "additionalContext": text}}
}

func blockOutput(reason string) map[string]any {
	return map[string]any{"decision": "block", "reason": reason}
}
