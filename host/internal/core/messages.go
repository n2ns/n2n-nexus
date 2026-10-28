package core

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

// ---------------------------------------------------------------------------
// identity

// identity resolves who a chat or meeting call acts as; without a resolver
// every call acts as its instance. Call it outside c.tx: the resolver uses
// the store, which has one connection.
func (c *Core) identity(call api.Call) (api.Identity, error) {
	if c.d.Identities == nil {
		return api.Identity{Kind: api.IdentityInstance, ID: call.Actor(), Instance: call.Actor()}, nil
	}
	return c.d.Identities.Identity(call)
}

// ---------------------------------------------------------------------------
// send_message

type sendMessageArgs struct {
	Message   string `json:"message"`
	Category  string `json:"category"`
	MeetingID string `json:"meetingId"`
	// Draft publishes the message as the meeting's current draft (a PROPOSAL).
	Draft bool `json:"draft"`
}

func (c *Core) sendMessage(call api.Call, a sendMessageArgs) (any, error) {
	if a.Draft {
		if a.Category != "" && a.Category != "PROPOSAL" {
			return nil, api.Errorf("A draft is a PROPOSAL; leave category out or set it to PROPOSAL, not %s.", a.Category)
		}
		a.Category = "PROPOSAL"
	}
	id, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = c.tx(call, func(tx *sql.Tx) error {
		meetingID := a.MeetingID
		if meetingID == "" {
			var err error
			if meetingID, err = defaultMeetingID(tx); err != nil {
				return err
			}
		}
		if meetingID != "" {
			m, err := loadMeeting(tx, meetingID)
			if err != nil {
				return err
			}
			if m.status != "active" {
				return api.Errorf("Meeting '%s' is %s, cannot add messages.", meetingID, m.status)
			}
			u, err := loadUnread(tx, meetingID, id.ID)
			if err != nil {
				return err
			}
			text := a.Message
			if len(u.messages) > 0 {
				// A draft or a DECISION becomes a decision's text: it is never let through unread.
				final := a.Draft || a.Category == "DECISION"
				if !u.refused || final {
					attached, note, err := c.attach(tx, u)
					if err != nil {
						return err
					}
					next := " Your next send_message to this meeting goes through even if more arrive, with a note of what was unread; a draft or a DECISION is posted only once everything is read."
					if final {
						next = " A draft or a DECISION is posted only once everything is read."
					}
					result = map[string]any{"ok": false, "refused": true, "sentTo": "meeting", "meetingId": meetingID, "identity": id.Kind, "unread": attached,
						"message": "Not sent: " + unreadNote(u) + " Take them into account and post again only if you still have something to add; do not resend the same text." + next + note}
					return c.setSendRefused(tx, u, true)
				}
				text += "\n\n" + fmt.Sprintf(c.d.Contract.Hook.Texts.SentWithUnread, u.span())
			}
			if u.refused {
				if err := c.setSendRefused(tx, u, false); err != nil {
					return err
				}
			}
			messageID, err := c.addMeetingMessage(tx, meetingID, id.ID, text, a.Category)
			if err != nil {
				return err
			}
			result = map[string]any{"ok": true, "sentTo": "meeting", "meetingId": meetingID, "messageId": messageID,
				"identity": id.Kind, "message": fmt.Sprintf("Message sent to meeting %s.", meetingID)}
			if !a.Draft {
				return nil
			}
			var row int64
			if err := tx.QueryRow(`SELECT id FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, messageID).Scan(&row); err != nil {
				return err
			}
			result["currentProposalId"] = messageID
			return publishDraft(tx, meetingID, row)
		}
		if a.Draft {
			return api.Errorf("A draft is published to a meeting: give meetingId, or start one; no meeting is active.")
		}
		res, err := tx.Exec(`INSERT INTO global_messages (sender, text, category, timestamp, sender_name, sender_machine)
			VALUES (?, ?, ?, ?, `+snapshotName+`, `+snapshotMachine+`)`,
			id.ID, a.Message, nullString(a.Category), c.now(), id.ID, id.ID)
		if err != nil {
			return err
		}
		messageID, err := res.LastInsertId()
		if err != nil {
			return err
		}
		result = map[string]any{"ok": true, "sentTo": "global", "messageId": messageID, "identity": id.Kind,
			"message": "Message sent to global chat."}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if meetingID, ok := result["meetingId"].(string); ok && result["ok"] == true && c.d.Meetings != nil {
		c.d.Meetings.MeetingUpdated(meetingID)
	}
	return result, nil
}

// addMeetingMessage appends to an active meeting, adds the sender to its
// participants and records a DECISION message as a decision; it returns the
// message's number in the meeting.
func (c *Core) addMeetingMessage(tx *sql.Tx, meetingID, from, text, category string) (int64, error) {
	var status, participantsJSON string
	err := tx.QueryRow(`SELECT status, participants FROM meetings WHERE id = ?`, meetingID).Scan(&status, &participantsJSON)
	if err == sql.ErrNoRows {
		return 0, notFoundMeeting(meetingID)
	}
	if err != nil {
		return 0, err
	}
	if status != "active" {
		return 0, api.Errorf("Meeting '%s' is %s, cannot add messages.", meetingID, status)
	}
	now := c.now()
	var seq int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(seq), 0) + 1 FROM meeting_messages WHERE meeting_id = ?`, meetingID).Scan(&seq); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO meeting_messages (meeting_id, seq, sender, text, category, timestamp, sender_name, sender_machine)
		VALUES (?, ?, ?, ?, ?, ?, `+snapshotName+`, `+snapshotMachine+`)`,
		meetingID, seq, from, text, nullString(category), now, from, from); err != nil {
		return 0, err
	}
	var participants []string
	if err := json.Unmarshal([]byte(participantsJSON), &participants); err != nil {
		return 0, err
	}
	known := false
	for _, p := range participants {
		known = known || p == from
	}
	if !known {
		raw, _ := json.Marshal(append(participants, from))
		if _, err := tx.Exec(`UPDATE meetings SET participants = ? WHERE id = ?`, string(raw), meetingID); err != nil {
			return 0, err
		}
	}
	if category == "DECISION" {
		if _, err := tx.Exec(`INSERT INTO decisions (meeting_id, content, timestamp) VALUES (?, ?, ?)`, meetingID, text, now); err != nil {
			return 0, err
		}
	}
	return seq, nil
}

// ---------------------------------------------------------------------------
// read_messages

type readMessagesArgs struct {
	Count     int    `json:"count"`
	MeetingID string `json:"meetingId"`
	Latest    bool   `json:"latest"`
	AfterID   *int64 `json:"afterId"`
}

// machineSQL is a session's machine as shown, "<label or hostname> ·
// <platform>[ <environment>]", for the agent_sessions row aliased s.
const machineSQL = `CASE WHEN s.label != '' THEN s.label ELSE s.hostname END || ' · ' ||
	CASE s.platform WHEN 'darwin' THEN 'macOS' WHEN 'linux' THEN 'Linux' WHEN 'wsl' THEN 'WSL' WHEN 'win32' THEN 'Windows' END ||
	CASE WHEN s.environment != '' THEN ' ' || s.environment ELSE '' END`

// Snapshots of a session (its id the argument), NULL for an adapter instance:
// what a row shows of who wrote it, kept after the session is deleted.
const (
	snapshotName    = `(SELECT s.name FROM agent_sessions s WHERE s.id = ?)`
	snapshotTitle   = `(SELECT s.title FROM agent_sessions s WHERE s.id = ?)`
	snapshotMachine = `(SELECT ` + machineSQL + ` FROM agent_sessions s WHERE s.id = ?)`
)

// chatMessage is a global or meeting message. ID is its number: the global
// chat id, or its number in the meeting; row is the table id, which orders
// messages and keeps read cursors. SenderName and SenderMachine are the
// sending session's name and machine when it wrote the message, null for an
// instance; SenderBackfilled says they were filled in later, when the
// database was upgraded, from the session as it was then. Category is null
// when none was given.
type chatMessage struct {
	row              int64
	ID               int64   `json:"id"`
	From             string  `json:"from"`
	SenderName       *string `json:"senderName"`
	SenderMachine    *string `json:"senderMachine"`
	SenderBackfilled bool    `json:"senderBackfilled"`
	Text             string  `json:"text"`
	Category         *string `json:"category"`
	Timestamp        string  `json:"timestamp"`
}

// firstGlobalReadNote is returned by the first unread read of global chat as a session.
const firstGlobalReadNote = "First read of global chat as this session: unread messages are counted from now on. Use latest or afterId to see earlier messages."

// messageSource is the table and filter of one read_messages context.
type messageSource struct {
	contextType, contextID string
	table                  string
	// number is the column of the message number shown as id.
	number string
	// where filters the context ("" for global chat); args are its arguments.
	where string
	args  []any
}

func sourceOf(meetingID string) messageSource {
	if meetingID == "" {
		return messageSource{contextType: "global", contextID: "global", table: "global_messages", number: "m.id"}
	}
	return messageSource{contextType: "meeting", contextID: meetingID, table: "meeting_messages", number: "m.seq",
		where: "m.meeting_id = ? AND ", args: []any{meetingID}}
}

// query selects the context's messages matching cond (with its arguments appended).
func (s messageSource) query(tx *sql.Tx, cond, tail string, args ...any) ([]chatMessage, error) {
	rows, err := tx.Query(`SELECT m.id, `+s.number+`, m.sender, m.text, m.category, m.timestamp, m.sender_name, m.sender_machine, m.snapshot_backfilled
		FROM `+s.table+` m
		WHERE `+s.where+cond+` `+tail, append(append([]any{}, s.args...), args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []chatMessage
	for rows.Next() {
		var m chatMessage
		var category, name, machine sql.NullString
		if err := rows.Scan(&m.row, &m.ID, &m.From, &m.Text, &category, &m.Timestamp, &name, &machine, &m.SenderBackfilled); err != nil {
			return nil, err
		}
		m.Category, m.SenderName, m.SenderMachine = nullable(category), nullable(name), nullable(machine)
		out = append(out, m)
	}
	return out, rows.Err()
}

// maxID is the table id of the context's newest message, or 0.
func (s messageSource) maxID(tx *sql.Tx) (int64, error) {
	var id int64
	err := tx.QueryRow(`SELECT COALESCE(MAX(m.id), 0) FROM `+s.table+` m WHERE `+s.where+`1`, s.args...).Scan(&id)
	return id, err
}

func (c *Core) readMessages(call api.Call, a readMessagesArgs) (any, error) {
	if a.Latest && a.AfterID != nil {
		return nil, api.Errorf("read_messages takes latest or afterId, not both.")
	}
	src := sourceOf(a.MeetingID)
	history := a.Latest || a.AfterID != nil
	// History reads need no identity: they neither read nor move a cursor.
	var id api.Identity
	if !history {
		var err error
		if id, err = c.identity(call); err != nil {
			return nil, err
		}
		if id.Kind == api.IdentityInstance && call.InstanceID == "" {
			return nil, api.Errorf("read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically) to keep unread cursors; history reads (latest or afterId) need none.")
		}
	}
	var messages []chatMessage
	note := ""
	err := c.tx(call, func(tx *sql.Tx) error {
		if a.MeetingID != "" {
			if ok, err := meetingExists(tx, a.MeetingID); err != nil {
				return err
			} else if !ok {
				return notFoundMeeting(a.MeetingID)
			}
		}
		var err error
		switch {
		case a.Latest:
			messages, err = src.query(tx, "1", "ORDER BY m.id DESC LIMIT ?", a.Count)
			slices.Reverse(messages)
			return err
		case a.AfterID != nil:
			messages, err = src.query(tx, src.number+" > ?", "ORDER BY m.id LIMIT ?", *a.AfterID, a.Count)
			return err
		}
		var last int64
		err = tx.QueryRow(`SELECT last_read_id FROM read_cursors WHERE instance_id = ? AND context_type = ? AND context_id = ?`,
			id.ID, src.contextType, src.contextID).Scan(&last)
		first := err == sql.ErrNoRows
		if err != nil && !first {
			return err
		}
		var cursor int64
		switch {
		case first && id.Kind == api.IdentitySession && a.MeetingID == "":
			// A session's first read of global chat starts at the newest message.
			if cursor, err = src.maxID(tx); err != nil {
				return err
			}
			note = firstGlobalReadNote
		default:
			// The caller's own messages are left out; the cursor moves past them.
			if messages, err = src.query(tx, "m.id > ? AND m.sender != ?", "ORDER BY m.id LIMIT ?", last, id.ID, a.Count); err != nil {
				return err
			}
			if len(messages) == a.Count {
				cursor = messages[len(messages)-1].row
			} else {
				// Fewer than count: the scan reached the newest message.
				if cursor, err = src.maxID(tx); err != nil {
					return err
				}
			}
			if cursor <= last {
				return nil
			}
		}
		_, err = tx.Exec(`
			INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (instance_id, context_type, context_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
			id.ID, src.contextType, src.contextID, cursor, c.now())
		return err
	})
	if err != nil {
		return nil, err
	}
	result := map[string]any{"mode": "unread", "count": len(messages)}
	if history {
		result["mode"] = "history"
	} else {
		result["identity"] = id.Kind
	}
	if note != "" {
		result["note"] = note
	}
	if messages == nil {
		messages = []chatMessage{}
	}
	result["source"], result["messages"] = "global", messages
	if a.MeetingID != "" {
		result["source"], result["meetingId"] = "meeting", a.MeetingID
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// list_events

type listEventsArgs struct {
	Limit  int    `json:"limit"`
	Action string `json:"action"`
}

type event struct {
	ID        int64           `json:"id"`
	Timestamp string          `json:"timestamp"`
	Actor     string          `json:"actor"`
	Action    string          `json:"action"`
	Target    string          `json:"target,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
}

func (c *Core) listEvents(call api.Call, a listEventsArgs) (any, error) {
	events := []event{}
	err := c.tx(call, func(tx *sql.Tx) error {
		var rows *sql.Rows
		var err error
		if a.Action != "" {
			// Exact comparison: LIKE folds ASCII case and treats '_' and '%' as wildcards.
			rows, err = tx.Query(`SELECT id, timestamp, actor, action, target, detail FROM events
				WHERE action = ? OR substr(action, 1, length(?) + 1) = ? || '.' ORDER BY id DESC LIMIT ?`,
				a.Action, a.Action, a.Action, a.Limit)
		} else {
			rows, err = tx.Query(`SELECT id, timestamp, actor, action, target, detail FROM events ORDER BY id DESC LIMIT ?`, a.Limit)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e event
			var target, detail sql.NullString
			if err := rows.Scan(&e.ID, &e.Timestamp, &e.Actor, &e.Action, &target, &detail); err != nil {
				return err
			}
			e.Target = target.String
			if detail.Valid && detail.String != "" {
				e.Detail = json.RawMessage(detail.String)
			}
			events = append(events, e)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": len(events), "events": events}, nil
}

// ---------------------------------------------------------------------------
// host_maintenance

type maintenanceArgs struct {
	Action    string `json:"action"`
	Count     int64  `json:"count"`
	DryRun    bool   `json:"dryRun"`
	MeetingID string `json:"meetingId"`
}

func (c *Core) hostMaintenance(call api.Call, a maintenanceArgs) (any, error) {
	switch a.Action {
	case "cleanup":
		r, err := c.Cleanup(call.Ctx, call.Actor(), a.DryRun)
		if err != nil {
			return nil, err
		}
		verb := "Removed or changed"
		if a.DryRun {
			verb = "Dry run, nothing changed; would remove or change"
		}
		return map[string]any{"ok": true, "message": verb + ": " + r.Counts.String() + ".", "cleanup": r}, nil
	case "export":
		if a.MeetingID == "" {
			return nil, api.Errorf("host_maintenance export needs meetingId.")
		}
		var md string
		err := c.tx(call, func(tx *sql.Tx) (err error) {
			md, err = exportMeeting(tx, a.MeetingID)
			return err
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": fmt.Sprintf("Meeting %s as markdown.", a.MeetingID), "markdown": md}, nil
	}
	if a.Action == "prune" && a.Count < 1 {
		return nil, api.Errorf("host_maintenance prune needs count ≥ 1 (the number of oldest global messages to remove); use action \"clear\" to remove all.")
	}
	var removed, remaining int64
	err := c.tx(call, func(tx *sql.Tx) error {
		var err error
		switch {
		case a.Action == "clear":
			removed, err = exec(tx, `DELETE FROM global_messages`)
		case a.Count > 0:
			removed, err = exec(tx, `DELETE FROM global_messages WHERE id IN (SELECT id FROM global_messages ORDER BY id LIMIT ?)`, a.Count)
		}
		if err != nil {
			return err
		}
		if err := tx.QueryRow(`SELECT COUNT(*) FROM global_messages`).Scan(&remaining); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "maintenance."+a.Action, "", map[string]any{"removed": removed})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "removed": removed, "remaining": remaining,
		"message": fmt.Sprintf("Removed %d global messages.", removed)}, nil
}
