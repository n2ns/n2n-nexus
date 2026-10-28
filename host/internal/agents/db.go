package agents

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Queries on the agent tables. Every caller holds Agents.mu, so a read
// followed by a write sees no other agent request in between; statements that
// must commit together run in one transaction. The store has one connection:
// inside a transaction every query goes through the tx.

type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// bg: database work is not tied to the request (a client going away must not
// undo a status change it caused).
var bg = context.Background()

type session struct {
	ID, Client, Name, Note, Cwd, Status string
	// Title is the conversation's title, for display only; TitleSource is
	// "client" (from the hooks), "self" (set_profile) or "" (none).
	Title, TitleSource string
	machine
	// Label is a short machine name the session set itself, shown in place of Hostname.
	Label                   string
	Listening               bool
	CreatedAt, LastActiveAt string
}

// machine is where a conversation runs, as its hooks report it: Platform is
// darwin, linux, wsl or win32; UTCOffset is local time minus UTC in minutes.
type machine struct {
	Hostname, Platform string
	UTCOffset          int
}

// machineName is how a session's machine is shown: "<label or hostname> · <platform>", either part alone, or "".
func (s *session) machineName() string {
	name := s.Label
	if name == "" {
		name = s.Hostname
	}
	plat := platformNames[s.Platform]
	switch {
	case name != "" && plat != "":
		return name + " · " + plat
	case name != "":
		return name
	default:
		return plat
	}
}

var platformNames = map[string]string{"darwin": "macOS", "linux": "Linux", "wsl": "WSL", "win32": "Windows"}

// knownPlatform: a platform value the hooks may report.
func knownPlatform(platform string) bool {
	_, ok := platformNames[platform]
	return ok
}

type message struct {
	ID, FromID, FromName, FromTitle, FromMachine, ToID, Text string
	ReplyTo                                                  *string
	Status, CreatedAt, ExpiresAt                             string
	NotifiedAt, ReadAt                                       *string
	// ExpectsReply: the sender wants an answer; Wake: the message may wake the recipient.
	ExpectsReply, Wake bool
}

type notice struct {
	ID        int64
	SessionID string
	Text      string
	// MeetingID is the meeting the notice comes from, "" for none.
	MeetingID string
	// Wakes: the notice may wake the session (not from a meeting it left or takes part in asynchronously).
	Wakes bool
}

const sessionColumns = "id, client, name, note, cwd, status, listening, created_at, last_active_at, title, title_source, hostname, platform, utc_offset, label"

func scanSession(row interface{ Scan(...any) error }) (*session, error) {
	var s session
	var listening int
	if err := row.Scan(&s.ID, &s.Client, &s.Name, &s.Note, &s.Cwd, &s.Status, &listening, &s.CreatedAt, &s.LastActiveAt, &s.Title, &s.TitleSource, &s.Hostname, &s.Platform, &s.UTCOffset, &s.Label); err != nil {
		return nil, err
	}
	s.Listening = listening == 1
	return &s, nil
}

func querySessions(q querier, query string, args ...any) ([]*session, error) {
	rows, err := q.QueryContext(bg, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// getSession returns the session, or nil when there is none.
func getSession(q querier, id string) (*session, error) {
	s, err := scanSession(q.QueryRowContext(bg, "SELECT "+sessionColumns+" FROM agent_sessions WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return s, err
}

func (a *Agents) tx(fn func(tx *sql.Tx) error) error { return a.o.Store.Tx(bg, fn) }

func (a *Agents) db() *sql.DB { return a.o.Store.DB }

func (a *Agents) iso(t time.Time) string { return store.ISO(t) }

func ms(n int64) time.Duration { return time.Duration(n) * time.Millisecond }

// nameTaken: whether a session other than exceptID that is not offline uses name.
func nameTaken(q querier, name, exceptID string) (bool, error) {
	var one int
	err := q.QueryRowContext(bg, "SELECT 1 FROM agent_sessions WHERE name = ? AND id != ? AND status != 'offline' LIMIT 1", name, exceptID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// freeName: base, or base#N with the smallest N >= 2 that no other non-offline session uses.
func freeName(q querier, base, exceptID string) (string, error) {
	rows, err := q.QueryContext(bg, "SELECT name FROM agent_sessions WHERE id != ? AND status != 'offline'", exceptID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	taken := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return "", err
		}
		taken[n] = true
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if !taken[base] {
		return base, nil
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s#%d", base, n)
		if !taken[candidate] {
			return candidate, nil
		}
	}
}

// baseName is the last element of a client's working directory (either
// separator: the client may run on another system than the host), or "".
func baseName(cwd string) string {
	trimmed := strings.TrimRight(cwd, `/\`)
	if i := strings.LastIndexAny(trimmed, `/\`); i >= 0 {
		return trimmed[i+1:]
	}
	return trimmed
}

// touch creates the session if it does not exist (named <client>@<cwd basename>)
// and refreshes its last activity time and where it runs; m is nil only for an
// event the client sends on its behalf (BackgroundWait), which never creates a session.
func (a *Agents) touch(id, client, cwd string, m *machine, now time.Time) error {
	return a.tx(func(tx *sql.Tx) error {
		at := a.iso(now)
		existing, err := getSession(tx, id)
		if err != nil {
			return err
		}
		if existing != nil {
			if m == nil {
				_, err = tx.ExecContext(bg, "UPDATE agent_sessions SET last_active_at = ? WHERE id = ?", at, id)
			} else {
				_, err = tx.ExecContext(bg, "UPDATE agent_sessions SET last_active_at = ?, hostname = ?, platform = ?, utc_offset = ? WHERE id = ?", at, m.Hostname, m.Platform, m.UTCOffset, id)
			}
			return err
		}
		base := baseName(cwd)
		if base == "" {
			base = "session"
		}
		name, err := freeName(tx, client+"@"+base, id)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(bg,
			"INSERT INTO agent_sessions (id, client, name, note, cwd, status, listening, created_at, last_active_at, hostname, platform, utc_offset) VALUES (?, ?, ?, '', ?, 'idle', 0, ?, ?, ?, ?, ?)",
			id, client, name, cwd, at, at, m.Hostname, m.Platform, m.UTCOffset)
		return err
	})
}

// refresh sets the last activity time of an existing session.
func (a *Agents) refresh(id string, now time.Time) error {
	_, err := a.db().ExecContext(bg, "UPDATE agent_sessions SET last_active_at = ? WHERE id = ?", a.iso(now), id)
	return err
}

// stripNumber removes a trailing #N from a session name.
func stripNumber(name string) string {
	if i := strings.LastIndex(name, "#"); i >= 0 && i < len(name)-1 {
		for _, r := range name[i+1:] {
			if r < '0' || r > '9' {
				return name
			}
		}
		return name[:i]
	}
	return name
}

// setStatus sets the status. A session coming back from offline whose name
// another non-offline session now uses gets a numbered name.
func (a *Agents) setStatus(id, status string) error {
	return a.tx(func(tx *sql.Tx) error {
		current, err := getSession(tx, id)
		if err != nil || current == nil {
			return err
		}
		if current.Status == "offline" && status != "offline" {
			taken, err := nameTaken(tx, current.Name, id)
			if err != nil {
				return err
			}
			if taken {
				name, err := freeName(tx, stripNumber(current.Name), id)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(bg, "UPDATE agent_sessions SET name = ? WHERE id = ?", name, id); err != nil {
					return err
				}
			}
		}
		_, err = tx.ExecContext(bg, "UPDATE agent_sessions SET status = ? WHERE id = ?", status, id)
		return err
	})
}

// setStatusIf sets the status only while it is still expected.
func (a *Agents) setStatusIf(id, expected, status string) error {
	_, err := a.db().ExecContext(bg, "UPDATE agent_sessions SET status = ? WHERE id = ? AND status = ?", status, id, expected)
	return err
}

func (a *Agents) setListening(id string, on bool) error {
	v := 0
	if on {
		v = 1
	}
	_, err := a.db().ExecContext(bg, "UPDATE agent_sessions SET listening = ? WHERE id = ?", v, id)
	return err
}

// setClientTitle stores the title the client's hook reported, cut to
// maxTitleChars characters (code points, as the client and set_profile's
// schema count), unless the session set its own with set_profile; an
// unchanged title is not written.
func (a *Agents) setClientTitle(id, title string) error {
	if r := []rune(title); len(r) > a.o.Contract.Hook.Limits.MaxTitleChars {
		title = string(r[:a.o.Contract.Hook.Limits.MaxTitleChars])
	}
	if title == "" {
		return nil
	}
	_, err := a.db().ExecContext(bg, "UPDATE agent_sessions SET title = ?, title_source = 'client' WHERE id = ? AND title_source != 'self' AND title != ?", title, id, title)
	return err
}

// updateProfile sets name, note, title and/or label; a name another non-offline session uses is the caller's error.
// A non-empty title is the session's own (the client's no longer replaces it); "" clears it and lets the client's apply again.
func (a *Agents) updateProfile(id string, name, note, title, label *string) (*session, error) {
	var out *session
	err := a.tx(func(tx *sql.Tx) error {
		if name != nil {
			taken, err := nameTaken(tx, *name, id)
			if err != nil {
				return err
			}
			if taken {
				return api.Errorf("Name '%s' is already used by another session.", *name)
			}
			if _, err := tx.ExecContext(bg, "UPDATE agent_sessions SET name = ? WHERE id = ?", *name, id); err != nil {
				return err
			}
		}
		if note != nil {
			if _, err := tx.ExecContext(bg, "UPDATE agent_sessions SET note = ? WHERE id = ?", *note, id); err != nil {
				return err
			}
		}
		if title != nil {
			source := "self"
			if *title == "" {
				source = ""
			}
			if _, err := tx.ExecContext(bg, "UPDATE agent_sessions SET title = ?, title_source = ? WHERE id = ?", *title, source, id); err != nil {
				return err
			}
		}
		if label != nil {
			if _, err := tx.ExecContext(bg, "UPDATE agent_sessions SET label = ? WHERE id = ?", *label, id); err != nil {
				return err
			}
		}
		var err error
		out, err = getSession(tx, id)
		return err
	})
	return out, err
}

// findRecipient: a session by exact id (any status), else a non-offline session by name.
func (a *Agents) findRecipient(to string) (*session, error) {
	s, err := getSession(a.db(), to)
	if err != nil || s != nil {
		return s, err
	}
	list, err := querySessions(a.db(), "SELECT "+sessionColumns+" FROM agent_sessions WHERE name = ? AND status != 'offline' ORDER BY last_active_at DESC LIMIT 1", to)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return list[0], nil
}

// expireStale sets idle and working sessions without activity since before
// offline; it returns them.
func (a *Agents) expireStale(before time.Time) ([]string, error) {
	var ids []string
	err := a.tx(func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(bg, "SELECT id FROM agent_sessions WHERE status IN ('idle', 'working') AND last_active_at < ?", a.iso(before))
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		_, err = tx.ExecContext(bg, "UPDATE agent_sessions SET status = 'offline' WHERE status IN ('idle', 'working') AND last_active_at < ?", a.iso(before))
		return err
	})
	return ids, err
}

// listPeers: other sessions that are not offline or were active within the peer window, most recent first.
func (a *Agents) listPeers(selfID string, now time.Time) ([]*session, error) {
	since := now.Add(-ms(a.o.Contract.Hook.Timing.PeerWindowMs))
	return querySessions(a.db(), "SELECT "+sessionColumns+" FROM agent_sessions WHERE id != ? AND (status != 'offline' OR last_active_at > ?) ORDER BY last_active_at DESC", selfID, a.iso(since))
}

func (a *Agents) addMessage(fromID, toID, text string, replyTo *string, expectsReply, wake bool, now time.Time) (string, error) {
	id := uuid.NewString()
	_, err := a.db().ExecContext(bg,
		"INSERT INTO agent_messages (id, from_id, to_id, text, reply_to, status, created_at, expires_at, expects_reply, wake) VALUES (?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?)",
		id, fromID, toID, text, replyTo, a.iso(now), a.iso(now.Add(ms(a.o.Contract.Hook.Timing.MessageTtlMs))), expectsReply, wake)
	return id, err
}

const messageSelect = `
    SELECT m.id, m.from_id, s.name AS from_name, s.title AS from_title, s.hostname, s.platform, s.label, m.to_id, m.text, m.reply_to, m.status,
           m.created_at, m.expires_at, m.notified_at, m.read_at, m.expects_reply, m.wake
    FROM agent_messages m JOIN agent_sessions s ON s.id = m.from_id`

func queryMessages(q querier, query string, args ...any) ([]*message, error) {
	rows, err := q.QueryContext(bg, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*message
	for rows.Next() {
		var m message
		var from session
		if err := rows.Scan(&m.ID, &m.FromID, &m.FromName, &m.FromTitle, &from.Hostname, &from.Platform, &from.Label, &m.ToID, &m.Text, &m.ReplyTo, &m.Status, &m.CreatedAt, &m.ExpiresAt, &m.NotifiedAt, &m.ReadAt, &m.ExpectsReply, &m.Wake); err != nil {
			return nil, err
		}
		m.FromMachine = from.machineName()
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (a *Agents) getMessage(id string) (*message, error) {
	list, err := queryMessages(a.db(), messageSelect+" WHERE m.id = ?", id)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return list[0], nil
}

// unread: unread messages for a session, oldest first; freshOnly keeps those not notified yet.
func unread(q querier, toID string, freshOnly bool) ([]*message, error) {
	query := messageSelect + " WHERE m.to_id = ? AND m.status = 'unread'"
	if freshOnly {
		query += " AND m.notified_at IS NULL"
	}
	return queryMessages(q, query+" ORDER BY m.created_at, m.rowid", toID)
}

// pendingNotices: notices not delivered by a hook yet, oldest first.
func (a *Agents) pendingNotices(sessionID string) ([]notice, error) {
	rows, err := a.db().QueryContext(bg, `SELECT n.id, n.session_id, n.text, COALESCE(n.meeting_id, ''), COALESCE(mm.mode, 'active') = 'active' AND mm.left_at IS NULL
		FROM agent_notices n LEFT JOIN meeting_members mm ON mm.meeting_id = n.meeting_id AND mm.member_id = n.session_id
		WHERE n.session_id = ? AND n.notified_at IS NULL ORDER BY n.id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []notice
	for rows.Next() {
		var n notice
		if err := rows.Scan(&n.ID, &n.SessionID, &n.Text, &n.MeetingID, &n.Wakes); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// addNotice adds a notice for a session; meetingID is the meeting it comes from, "" for none.
func (a *Agents) addNotice(q querier, sessionID, text, meetingID string, now time.Time) error {
	_, err := q.ExecContext(bg, "INSERT INTO agent_notices (session_id, text, created_at, meeting_id) VALUES (?, ?, ?, ?)",
		sessionID, text, a.iso(now), sql.NullString{String: meetingID, Valid: meetingID != ""})
	return err
}

// unmarkNotified marks messages and notices as not notified again (a wake
// whose delivery failed); the messages it showed whole are unread again.
func (a *Agents) unmarkNotified(messageIDs []string, noticeIDs []int64) error {
	return a.tx(func(tx *sql.Tx) error {
		for _, id := range messageIDs {
			if _, err := tx.ExecContext(bg, "UPDATE agent_messages SET notified_at = NULL, status = 'unread', read_at = NULL WHERE id = ? AND status IN ('unread', 'read')", id); err != nil {
				return err
			}
		}
		for _, id := range noticeIDs {
			if _, err := tx.ExecContext(bg, "UPDATE agent_notices SET notified_at = NULL WHERE id = ?", id); err != nil {
				return err
			}
		}
		return nil
	})
}

// readUnread returns the oldest count unread messages, marked read, and the unread count left.
func (a *Agents) readUnread(toID string, count int, now time.Time) ([]*message, int, error) {
	var messages []*message
	var remaining int
	err := a.tx(func(tx *sql.Tx) error {
		all, err := unread(tx, toID, false)
		if err != nil {
			return err
		}
		if len(all) > count {
			all = all[:count]
		}
		messages = all
		at := a.iso(now)
		for _, m := range messages {
			if _, err := tx.ExecContext(bg, "UPDATE agent_messages SET status = 'read', read_at = ?, notified_at = COALESCE(notified_at, ?) WHERE id = ?", at, at, m.ID); err != nil {
				return err
			}
		}
		return tx.QueryRowContext(bg, "SELECT COUNT(*) FROM agent_messages WHERE to_id = ? AND status = 'unread'", toID).Scan(&remaining)
	})
	return messages, remaining, err
}

// subscribeIdle adds a one-shot notifyWhenIdle subscription; repeating it restarts its lifetime.
func (a *Agents) subscribeIdle(subscriberID, targetID string, now time.Time) error {
	_, err := a.db().ExecContext(bg, "INSERT OR REPLACE INTO agent_idle_subscriptions (subscriber_id, target_id, created_at) VALUES (?, ?, ?)", subscriberID, targetID, a.iso(now))
	return err
}

// fireIdle: the target finished its turn ("idle") or went offline; every live
// subscriber gets a notice and all subscriptions on the target are dropped.
// Returns the notified subscribers.
func (a *Agents) fireIdle(targetID, event string, now time.Time) ([]string, error) {
	var subscribers []string
	err := a.tx(func(tx *sql.Tx) error {
		target, err := getSession(tx, targetID)
		if err != nil || target == nil {
			return err
		}
		since := now.Add(-ms(a.o.Contract.Hook.Timing.IdleSubscriptionTtlMs))
		rows, err := tx.QueryContext(bg, "SELECT subscriber_id FROM agent_idle_subscriptions WHERE target_id = ? AND created_at > ?", targetID, a.iso(since))
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			subscribers = append(subscribers, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		text := fmt.Sprintf("%s (%s) finished its turn.", target.Name, target.ID)
		if event == "offline" {
			text = fmt.Sprintf("%s (%s) went offline.", target.Name, target.ID)
		}
		for _, s := range subscribers {
			if err := a.addNotice(tx, s, text, "", now); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(bg, "DELETE FROM agent_idle_subscriptions WHERE target_id = ?", targetID)
		return err
	})
	return subscribers, err
}

// expireMessages expires unread messages past expires_at and tells their
// senders; returns the notified senders and how many messages expired.
func (a *Agents) expireMessages(now time.Time) ([]string, int, error) {
	var senders []string
	var n int
	err := a.tx(func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(bg, `
            SELECT m.id, m.from_id, m.to_id, m.text, s.name
            FROM agent_messages m JOIN agent_sessions s ON s.id = m.to_id
            WHERE m.status = 'unread' AND m.expires_at <= ?`, a.iso(now))
		if err != nil {
			return err
		}
		type row struct{ id, from, to, text, toName string }
		var list []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.from, &r.to, &r.text, &r.toName); err != nil {
				rows.Close()
				return err
			}
			list = append(list, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, r := range list {
			if _, err := tx.ExecContext(bg, "UPDATE agent_messages SET status = 'expired' WHERE id = ?", r.id); err != nil {
				return err
			}
			text := fmt.Sprintf("Your message to %s (%s) expired unread: \"%s\"", r.toName, r.to, a.preview(r.text))
			if err := a.addNotice(tx, r.from, text, "", now); err != nil {
				return err
			}
			if !seen[r.from] {
				seen[r.from] = true
				senders = append(senders, r.from)
			}
		}
		n = len(list)
		return nil
	})
	return senders, n, err
}

func (a *Agents) bindToolUse(toolUseID, sessionID string, now time.Time) error {
	_, err := a.db().ExecContext(bg, "INSERT OR REPLACE INTO tool_use_bindings (tool_use_id, session_id, created_at) VALUES (?, ?, ?)", toolUseID, sessionID, a.iso(now))
	return err
}

// resolveToolUse returns the session bound to a toolUseId within the binding
// TTL, or ""; expired bindings are removed.
func (a *Agents) resolveToolUse(toolUseID string, now time.Time) (string, error) {
	cutoff := a.iso(now.Add(-ms(a.o.Contract.Hook.Timing.ToolUseBindingTtlMs)))
	if _, err := a.db().ExecContext(bg, "DELETE FROM tool_use_bindings WHERE created_at <= ?", cutoff); err != nil {
		return "", err
	}
	var id string
	err := a.db().QueryRowContext(bg, "SELECT session_id FROM tool_use_bindings WHERE tool_use_id = ? AND created_at > ?", toolUseID, cutoff).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// preview is the first line of a message, cut to the contract's preview length
// (counted in UTF-16 code units like the TypeScript clients; a surrogate pair is never split).
func (a *Agents) preview(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	line = strings.TrimSuffix(line, "\r")
	return cutUnits(line, a.o.Contract.Hook.Limits.PreviewChars)
}

// unitLen is the length of s in UTF-16 code units.
func unitLen(s string) int {
	units := 0
	for _, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		units += n
	}
	return units
}

// cutUnits cuts s to at most limit UTF-16 code units, never splitting a surrogate pair.
func cutUnits(s string, limit int) string {
	units := 0
	for i, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > limit {
			return s[:i]
		}
		units += n
	}
	return s
}

// displayName is how notifications name a session: its name, its machine in
// parentheses when known, and its title in quotes when it has one.
func displayName(name, machine, title string) string {
	if machine != "" {
		name = fmt.Sprintf("%s (%s)", name, machine)
	}
	if title == "" {
		return name
	}
	return fmt.Sprintf("%s \"%s\"", name, title)
}
