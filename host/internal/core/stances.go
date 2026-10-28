package core

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

// consensusSender is the sender of the DECISION a consensus writes.
const consensusSender = "n2n-nexus"

// isSessionID: a conversation session key (claude:<id> / codex:<id>), not an adapter instance id.
func isSessionID(id string) bool {
	return strings.HasPrefix(id, "claude:") || strings.HasPrefix(id, "codex:")
}

// draftRow is a meeting's current draft and its approver-list version.
type draftRow struct {
	row, seq int64
	author   string
	text     string
	version  int64
}

// currentDraft is the meeting's current draft; ok is false when it has none.
func currentDraft(tx *sql.Tx, meetingID string) (d draftRow, ok bool, err error) {
	err = tx.QueryRow(`
		SELECT m.id, m.seq, m.sender, m.text, mt.approvers_version
		FROM meetings mt JOIN meeting_messages m ON m.id = mt.current_proposal_id
		WHERE mt.id = ?`, meetingID).Scan(&d.row, &d.seq, &d.author, &d.text, &d.version)
	if err == sql.ErrNoRows {
		return d, false, nil
	}
	return d, err == nil, err
}

// approverIDs lists the required approvers of the meeting's current draft, in the order they were added.
func approverIDs(tx *sql.Tx, meetingID string) ([]string, error) {
	rows, err := tx.Query(`SELECT member_id FROM meeting_approvers WHERE meeting_id = ? ORDER BY rowid`, meetingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// publishDraft makes message row the meeting's current draft: a new approver
// list of the required session members that have not left, nothing reminded.
func publishDraft(tx *sql.Tx, meetingID string, row int64) error {
	if _, err := tx.Exec(`UPDATE meetings SET current_proposal_id = ?, approvers_version = approvers_version + 1,
		draft_reminded_at = NULL WHERE id = ?`, row, meetingID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM meeting_approvers WHERE meeting_id = ?`, meetingID); err != nil {
		return err
	}
	// Freeze who was present when this draft was published, including optional
	// approvers that may opt in later. Wall-clock timestamps cannot order joins.
	if _, err := tx.Exec(`UPDATE meeting_members SET draft_eligible = (left_at IS NULL AND identity_kind = 'session') WHERE meeting_id = ?`, meetingID); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO meeting_approvers (meeting_id, member_id)
		SELECT meeting_id, member_id FROM meeting_members
		WHERE meeting_id = ? AND draft_eligible = 1 AND approver = 'required' ORDER BY joined_at, rowid`, meetingID)
	return err
}

type objection struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

// approvals of one proposal. Required is the approver list when the proposal
// is the current draft, else empty; Waiting are the required approvers
// without a stance on it. Endorsed and Objections list every stance, an
// instance's too (its endorsement does not count, its objection blocks).
type approvals struct {
	Required   []string    `json:"required"`
	Endorsed   []string    `json:"endorsed"`
	Waiting    []string    `json:"waiting"`
	Objections []objection `json:"objections"`
}

// loadApprovals reads the approvals of the proposal with table id row.
func loadApprovals(tx *sql.Tx, meetingID string, row int64, current bool) (approvals, error) {
	a := approvals{Required: []string{}, Endorsed: []string{}, Waiting: []string{}, Objections: []objection{}}
	if current {
		var err error
		if a.Required, err = approverIDs(tx, meetingID); err != nil {
			return a, err
		}
	}
	rows, err := tx.Query(`SELECT member_id, stance, COALESCE(note, '') FROM meeting_stances
		WHERE meeting_id = ? AND message_id = ? ORDER BY at, rowid`, meetingID, row)
	if err != nil {
		return a, err
	}
	defer rows.Close()
	took := map[string]bool{}
	for rows.Next() {
		var id, stance, note string
		if err := rows.Scan(&id, &stance, &note); err != nil {
			return a, err
		}
		took[id] = true
		if stance == "endorse" {
			a.Endorsed = append(a.Endorsed, id)
		} else {
			a.Objections = append(a.Objections, objection{ID: id, Note: note})
		}
	}
	if err := rows.Err(); err != nil {
		return a, err
	}
	for _, id := range a.Required {
		if !took[id] {
			a.Waiting = append(a.Waiting, id)
		}
	}
	return a, nil
}

// closeMeeting closes an active meeting for reason ('manual' or 'consensus')
// and hands the default role to the most recently activated meeting still active.
func (c *Core) closeMeeting(tx *sql.Tx, id string, summary any, reason string) error {
	if _, err := tx.Exec(`UPDATE meetings SET status = 'closed', is_default = 0, closed_at = ?, summary = ?, end_reason = ? WHERE id = ?`,
		c.now(), summary, reason, id); err != nil {
		return err
	}
	var next string
	err := tx.QueryRow(`SELECT id FROM meetings WHERE status = 'active' ORDER BY active_order DESC LIMIT 1`).Scan(&next)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	return makeDefault(tx, next)
}

// decideByConsensus closes the meeting with a DECISION when its current draft
// has at least two required approvers, every one of them endorsed it and no
// session objects to it; byID is who caused the check. It reports whether the
// meeting was closed.
func (c *Core) decideByConsensus(tx *sql.Tx, meetingID, byID string) (bool, error) {
	m, err := loadMeeting(tx, meetingID)
	if err != nil || m.status != "active" {
		return false, err
	}
	d, ok, err := currentDraft(tx, meetingID)
	if err != nil || !ok {
		return false, err
	}
	required, err := approverIDs(tx, meetingID)
	if err != nil || len(required) < 2 {
		return false, err
	}
	rows, err := tx.Query(`SELECT member_id, stance, identity_kind FROM meeting_stances WHERE meeting_id = ? AND message_id = ?`, meetingID, d.row)
	if err != nil {
		return false, err
	}
	endorsed := map[string]bool{}
	objected := false
	for rows.Next() {
		var id, stance, kind string
		if err := rows.Scan(&id, &stance, &kind); err != nil {
			rows.Close()
			return false, err
		}
		// Any objection blocks, an instance's too; only listed sessions' endorsements count.
		endorsed[id] = stance == "endorse" && kind == api.IdentitySession
		objected = objected || stance == "object"
	}
	rows.Close()
	if err := rows.Err(); err != nil || objected {
		return false, err
	}
	for _, id := range required {
		if !endorsed[id] {
			return false, nil
		}
	}
	text := fmt.Sprintf(c.d.Contract.Hook.Texts.ConsensusDecision, d.seq, strings.Join(required, ", "), d.text)
	decision, err := c.addMeetingMessage(tx, meetingID, consensusSender, text, "DECISION")
	if err != nil {
		return false, err
	}
	// The summary goes into the members' closing notice: the meeting is closed, so its news is not announced.
	summary := fmt.Sprintf("decided by consensus on draft #%d (the DECISION is message #%d)", d.seq, decision)
	if err := c.closeMeeting(tx, meetingID, summary, "consensus"); err != nil {
		return false, err
	}
	return true, c.recordEvent(tx, byID, "meeting.end", meetingID, map[string]any{"topic": m.topic, "reason": "consensus"})
}

// approversChanged records a change of the current draft's approver list: a
// new version and, in an active meeting, a message by byID followed by a
// consensus check. It reports whether a message was written and whether the
// meeting was closed.
func (c *Core) approversChanged(tx *sql.Tx, meetingID, byID string, d draftRow) (posted, decided bool, err error) {
	if _, err := tx.Exec(`UPDATE meetings SET approvers_version = approvers_version + 1 WHERE id = ?`, meetingID); err != nil {
		return false, false, err
	}
	m, err := loadMeeting(tx, meetingID)
	if err != nil || m.status != "active" {
		return false, false, err
	}
	required, err := approverIDs(tx, meetingID)
	if err != nil {
		return false, false, err
	}
	list := "none"
	if len(required) > 0 {
		list = strings.Join(required, ", ")
	}
	text := fmt.Sprintf(c.d.Contract.Hook.Texts.ApproversChanged, d.seq, d.version+1, list)
	if _, err := c.addMeetingMessage(tx, meetingID, byID, text, "CHAT"); err != nil {
		return false, false, err
	}
	decided, err = c.decideByConsensus(tx, meetingID, byID)
	return true, decided, err
}

// afterMeetingChange tells the notifier, after the commit, about a new message and a close.
func (c *Core) afterMeetingChange(meetingID, byID string, posted, closed bool) {
	if c.d.Meetings == nil {
		return
	}
	if posted {
		c.d.Meetings.MeetingUpdated(meetingID)
	}
	if closed {
		c.d.Meetings.MeetingClosed(meetingID, byID)
	}
}

// ---------------------------------------------------------------------------
// stance

type stanceArgs struct {
	MeetingID string `json:"meetingId"`
	MessageID int64  `json:"messageId"`
	Stance    string `json:"stance"`
	Note      string `json:"note"`
}

var stanceVerbs = map[string]string{"endorse": "endorsed", "object": "objected to", "withdraw": "withdrew their stance on"}

func (c *Core) stance(call api.Call, a stanceArgs) (any, error) {
	note := strings.TrimSpace(a.Note)
	if a.Stance == "object" && note == "" {
		return nil, api.Errorf("An objection needs a note: the reason for it.")
	}
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	var author, topic string
	var currentID any
	var appr approvals
	var posted, decided bool
	// refused is the result of a stance refused for unread messages; a
	// withdrawal goes through with them attached.
	var refused map[string]any
	var unreadAttached []unreadMessage
	var unreadMessage string
	err = c.tx(call, func(tx *sql.Tx) error {
		m, err := loadMeeting(tx, a.MeetingID)
		if err != nil {
			return err
		}
		if m.status != "active" {
			return api.Errorf("Meeting '%s' is %s, cannot take a stance.", a.MeetingID, m.status)
		}
		topic = m.topic
		var row int64
		var category sql.NullString
		err = tx.QueryRow(`SELECT id, sender, category FROM meeting_messages WHERE meeting_id = ? AND seq = ?`,
			a.MeetingID, a.MessageID).Scan(&row, &author, &category)
		if err == sql.ErrNoRows {
			return api.Errorf("Meeting '%s' has no message %d.", a.MeetingID, a.MessageID)
		}
		if err != nil {
			return err
		}
		if category.String != "PROPOSAL" {
			return api.Errorf("Message %d of meeting '%s' is not a PROPOSAL; stances are taken on proposals.", a.MessageID, a.MeetingID)
		}
		// A stance needs what others said read first; withdrawing one does not.
		u, err := loadUnread(tx, a.MeetingID, who.ID)
		if err != nil {
			return err
		}
		if len(u.messages) > 0 {
			attached, note, err := c.attach(tx, u)
			if err != nil {
				return err
			}
			if a.Stance != "withdraw" {
				refused = map[string]any{"ok": false, "refused": true, "meetingId": a.MeetingID, "messageId": a.MessageID, "stance": a.Stance, "unread": attached,
					"message": "Stance not taken: " + unreadNote(u) + " Read them, then take your stance again if it still holds." + note}
				return nil
			}
			unreadAttached, unreadMessage = attached, unreadNote(u)+note
		}
		switch a.Stance {
		case "withdraw":
			n, err := exec(tx, `DELETE FROM meeting_stances WHERE meeting_id = ? AND message_id = ? AND member_id = ?`, a.MeetingID, row, who.ID)
			if err != nil {
				return err
			}
			if n == 0 {
				return api.Errorf("%s has no stance on message %d to withdraw.", who.ID, a.MessageID)
			}
		default:
			if _, err := tx.Exec(`
				INSERT INTO meeting_stances (meeting_id, message_id, member_id, identity_kind, stance, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (meeting_id, message_id, member_id) DO UPDATE SET identity_kind = excluded.identity_kind, stance = excluded.stance, note = excluded.note, at = excluded.at`,
				a.MeetingID, row, who.ID, who.Kind, a.Stance, nullString(note), c.now()); err != nil {
				return err
			}
		}
		if a.Stance == "object" {
			if _, err := c.addMeetingMessage(tx, a.MeetingID, who.ID, fmt.Sprintf("Objection to draft #%d: %s", a.MessageID, note), "CHAT"); err != nil {
				return err
			}
			posted = true
		}
		d, ok, err := currentDraft(tx, a.MeetingID)
		if err != nil {
			return err
		}
		if ok {
			currentID = d.seq
		}
		if appr, err = loadApprovals(tx, a.MeetingID, row, ok && d.row == row); err != nil {
			return err
		}
		if ok && d.row == row {
			decided, err = c.decideByConsensus(tx, a.MeetingID, who.ID)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	if refused != nil {
		return refused, nil
	}
	if c.d.Meetings != nil && isSessionID(author) && author != who.ID {
		name := who.Name
		if name == "" {
			name = who.ID
		}
		suffix := ""
		if note != "" {
			suffix = ": " + note
		}
		c.d.Meetings.MeetingNotice(a.MeetingID, []string{author},
			fmt.Sprintf(c.d.Contract.Hook.Texts.StanceNotice, name, stanceVerbs[a.Stance], a.MessageID, topic, a.MeetingID, suffix))
	}
	c.afterMeetingChange(a.MeetingID, who.ID, posted || decided, decided)
	result := map[string]any{"ok": true, "meetingId": a.MeetingID, "messageId": a.MessageID, "stance": a.Stance,
		"currentProposalId": currentID, "counted": who.Kind == api.IdentitySession, "approvals": appr, "decided": decided}
	if unreadAttached != nil {
		result["unread"], result["message"] = unreadAttached, "Stance withdrawn. "+unreadMessage
	}
	return result, nil
}
