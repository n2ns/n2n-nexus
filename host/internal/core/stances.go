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
		draft_reminded_at = NULL, consensus_draft = NULL WHERE id = ?`, row, meetingID); err != nil {
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
// In a meeting with the user's seat, the seat is in none of these lists but
// in Seat, with its stance; Seat is null in a meeting without one.
type approvals struct {
	Required   []string    `json:"required"`
	Endorsed   []string    `json:"endorsed"`
	Waiting    []string    `json:"waiting"`
	Objections []objection `json:"objections"`
	Seat       *seatStance `json:"seat"`
}

// seatStance is the user's seat and its stance on a proposal (null: none).
type seatStance struct {
	ID     string  `json:"id"`
	Stance *string `json:"stance"`
	Note   *string `json:"note"`
}

// loadApprovals reads the approvals of the proposal with table id row.
func loadApprovals(tx *sql.Tx, meetingID string, row int64, current bool) (approvals, error) {
	a := approvals{Required: []string{}, Endorsed: []string{}, Waiting: []string{}, Objections: []objection{}}
	seat, err := seatOf(tx, meetingID)
	if err != nil {
		return a, err
	}
	if seat != "" {
		a.Seat = &seatStance{ID: seat}
	}
	if current {
		ids, err := approverIDs(tx, meetingID)
		if err != nil {
			return a, err
		}
		for _, id := range ids {
			if id != seat {
				a.Required = append(a.Required, id)
			}
		}
	}
	rows, err := tx.Query(`SELECT member_id, stance, COALESCE(note, '') FROM meeting_stances
		WHERE meeting_id = ? AND message_id = ? AND withdrawn = 0 ORDER BY at, rowid`, meetingID, row)
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
		if id == seat {
			a.Seat.Stance, a.Seat.Note = &stance, &note
			continue
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

// consensusOn reports whether the meeting's current draft has at least two
// required approvers besides exclude (the seat, or ""), every one of them
// endorsed it and no session other than exclude objects to it; it also returns
// the draft (ok false: none) and those approvers.
func consensusOn(tx *sql.Tx, meetingID, exclude string) (d draftRow, ok bool, required []string, reached bool, err error) {
	if d, ok, err = currentDraft(tx, meetingID); err != nil || !ok {
		return d, ok, nil, false, err
	}
	ids, err := approverIDs(tx, meetingID)
	if err != nil {
		return d, ok, nil, false, err
	}
	for _, id := range ids {
		if id != exclude {
			required = append(required, id)
		}
	}
	if len(required) < 2 {
		return d, ok, required, false, nil
	}
	rows, err := tx.Query(`SELECT member_id, stance, identity_kind FROM meeting_stances WHERE meeting_id = ? AND message_id = ? AND withdrawn = 0`, meetingID, d.row)
	if err != nil {
		return d, ok, required, false, err
	}
	endorsed := map[string]bool{}
	objected := false
	for rows.Next() {
		var id, stance, kind string
		if err := rows.Scan(&id, &stance, &kind); err != nil {
			rows.Close()
			return d, ok, required, false, err
		}
		if id == exclude {
			continue
		}
		// Any objection blocks, an instance's too; only listed sessions' endorsements count.
		endorsed[id] = stance == "endorse" && kind == api.IdentitySession
		objected = objected || stance == "object"
	}
	rows.Close()
	if err := rows.Err(); err != nil || objected {
		return d, ok, required, false, err
	}
	for _, id := range required {
		if !endorsed[id] {
			return d, ok, required, false, nil
		}
	}
	return d, ok, required, true, nil
}

// checkConsensus runs after a stance or an approver change. A meeting
// without the user's seat closes with a DECISION on consensus (decided). In
// a meeting with a seat consensus decides nothing: the host only posts a
// message when the AI consensus on the current draft is reached or lost
// (posted).
func (c *Core) checkConsensus(tx *sql.Tx, meetingID, byID string) (posted, decided bool, err error) {
	seat, err := seatOf(tx, meetingID)
	if err != nil {
		return false, false, err
	}
	if seat == "" {
		decided, err = c.decideByConsensus(tx, meetingID, byID)
		return decided, decided, err
	}
	d, ok, required, reached, err := consensusOn(tx, meetingID, seat)
	if err != nil {
		return false, false, err
	}
	var was sql.NullInt64
	if err := tx.QueryRow(`SELECT consensus_draft FROM meetings WHERE id = ?`, meetingID).Scan(&was); err != nil {
		return false, false, err
	}
	var now sql.NullInt64
	if reached {
		now = sql.NullInt64{Int64: d.row, Valid: true}
	}
	if was == now {
		return false, false, nil
	}
	if _, err := tx.Exec(`UPDATE meetings SET consensus_draft = ? WHERE id = ?`, now, meetingID); err != nil {
		return false, false, err
	}
	texts := c.d.Contract.Hook.Texts
	var text string
	switch {
	case reached:
		text = fmt.Sprintf(texts.AiConsensus, d.seq, strings.Join(required, ", "))
	case ok && was.Int64 == d.row:
		text = fmt.Sprintf(texts.AiConsensusLost, d.seq)
	default:
		return false, false, nil // the draft it was about is gone
	}
	_, err = c.addMeetingMessage(tx, meetingID, consensusSender, text, "UPDATE")
	return err == nil, false, err
}

// decideByConsensus closes a meeting without a seat with a DECISION when
// consensusOn holds; byID is who caused the check. It reports whether the
// meeting was closed.
func (c *Core) decideByConsensus(tx *sql.Tx, meetingID, byID string) (bool, error) {
	m, err := loadMeeting(tx, meetingID)
	if err != nil || m.status != "active" {
		return false, err
	}
	d, _, required, reached, err := consensusOn(tx, meetingID, "")
	if err != nil || !reached {
		return false, err
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
	_, decided, err = c.checkConsensus(tx, meetingID, byID)
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
	// decisionID is the DECISION the seat's endorsement posted, 0 for none.
	var decisionID int64
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
		seat, err := seatOf(tx, a.MeetingID)
		if err != nil {
			return err
		}
		isSeat := seat == who.ID
		var prev sql.NullString
		var changes int
		var withdrawn bool
		err = tx.QueryRow(`SELECT stance, changes, withdrawn FROM meeting_stances WHERE meeting_id = ? AND message_id = ? AND member_id = ?`,
			a.MeetingID, row, who.ID).Scan(&prev, &changes, &withdrawn)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		// A change is a stance other than the last one taken, withdrawn or not.
		changed := a.Stance != "withdraw" && prev.Valid && prev.String != a.Stance
		// The seat speaks for the user: no grounds asked, no limit.
		if !isSeat && a.Stance != "withdraw" {
			if changed && changes >= maxStanceChanges {
				return api.Errorf("Your stance on proposal #%d is fixed after %d changes; with new grounds, say so with send_message and wait for the next draft. withdraw still works.", a.MessageID, maxStanceChanges)
			}
			if a.Stance == "object" || changed {
				if err := checkEvidence(tx, a.MeetingID, note); err != nil {
					return err
				}
			}
		}
		// A stance needs what others said read first; withdrawing one, or the seat's veto, does not.
		u, err := loadUnread(tx, a.MeetingID, who.ID)
		if err != nil {
			return err
		}
		if len(u.messages) > 0 {
			attached, unreadNoteText, err := c.attach(tx, u)
			if err != nil {
				return err
			}
			if a.Stance != "withdraw" && !(isSeat && a.Stance == "object") {
				refused = map[string]any{"ok": false, "refused": true, "meetingId": a.MeetingID, "messageId": a.MessageID, "stance": a.Stance, "unread": attached,
					"message": "Stance not taken: " + unreadNote(u) + " Read them, then take your stance again if it still holds." + unreadNoteText}
				return nil
			}
			unreadAttached, unreadMessage = attached, unreadNote(u)+unreadNoteText
		}
		switch a.Stance {
		case "withdraw":
			n, err := exec(tx, `UPDATE meeting_stances SET withdrawn = 1, at = ? WHERE meeting_id = ? AND message_id = ? AND member_id = ? AND withdrawn = 0`,
				c.now(), a.MeetingID, row, who.ID)
			if err != nil {
				return err
			}
			if n == 0 {
				return api.Errorf("%s has no stance on message %d to withdraw.", who.ID, a.MessageID)
			}
		default:
			if changed {
				changes++
			}
			if _, err := tx.Exec(`
				INSERT INTO meeting_stances (meeting_id, message_id, member_id, identity_kind, stance, note, at, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (meeting_id, message_id, member_id) DO UPDATE SET identity_kind = excluded.identity_kind, stance = excluded.stance,
					note = excluded.note, at = excluded.at, changes = excluded.changes, withdrawn = 0`,
				a.MeetingID, row, who.ID, who.Kind, a.Stance, nullString(note), c.now(), changes); err != nil {
				return err
			}
		}
		d, ok, err := currentDraft(tx, a.MeetingID)
		if err != nil {
			return err
		}
		current := ok && d.row == row
		if isSeat && current && a.Stance != "withdraw" {
			// The user decides the current draft: endorse makes it a decision, object voids it.
			if decisionID, err = c.seatDecides(tx, a.MeetingID, who, d, a.Stance, note); err != nil {
				return err
			}
			if appr, err = loadApprovals(tx, a.MeetingID, row, false); err != nil {
				return err
			}
			posted = true
			return nil
		}
		if a.Stance == "object" {
			if _, err := c.addMeetingMessage(tx, a.MeetingID, who.ID, fmt.Sprintf("Objection to draft #%d: %s", a.MessageID, note), "CHAT"); err != nil {
				return err
			}
			posted = true
		}
		if ok {
			currentID = d.seq
		}
		if appr, err = loadApprovals(tx, a.MeetingID, row, current); err != nil {
			return err
		}
		if current {
			var told bool
			told, decided, err = c.checkConsensus(tx, a.MeetingID, who.ID)
			posted = posted || told
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
	if decisionID != 0 {
		result["decisionId"] = decisionID
	}
	if unreadAttached != nil {
		done := "Stance taken. "
		if a.Stance == "withdraw" {
			done = "Stance withdrawn. "
		}
		result["unread"], result["message"] = unreadAttached, done+unreadMessage
	}
	return result, nil
}

// seatDecides applies the seat's stance on the current draft d: endorse posts
// the DECISION (the draft's text, with the objections still open), object
// posts the veto; either way the meeting has no current draft afterwards. It
// returns the DECISION's number, 0 for a veto.
func (c *Core) seatDecides(tx *sql.Tx, meetingID string, seat api.Identity, d draftRow, stance, note string) (int64, error) {
	texts := c.d.Contract.Hook.Texts
	var decision int64
	who, err := memberLabel(tx, meetingID, seat.ID)
	if err != nil {
		return 0, err
	}
	if stance == "endorse" {
		appr, err := loadApprovals(tx, meetingID, d.row, true)
		if err != nil {
			return 0, err
		}
		detail, open := "", ""
		if note != "" {
			detail = ": " + note
		}
		if len(appr.Objections) > 0 {
			var list []string
			for _, o := range appr.Objections {
				list = append(list, o.ID+": "+o.Note)
			}
			open = fmt.Sprintf(texts.SeatOpenObjections, strings.Join(list, "; "))
		}
		text := fmt.Sprintf(texts.SeatDecision, d.seq, who, detail, open, d.text)
		if decision, err = c.addMeetingMessage(tx, meetingID, consensusSender, text, "DECISION"); err != nil {
			return 0, err
		}
	} else if _, err := c.addMeetingMessage(tx, meetingID, consensusSender, fmt.Sprintf(texts.SeatVeto, d.seq, who, note), "UPDATE"); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE meetings SET current_proposal_id = NULL, consensus_draft = NULL, draft_reminded_at = NULL WHERE id = ?`, meetingID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM meeting_approvers WHERE meeting_id = ?`, meetingID); err != nil {
		return 0, err
	}
	return decision, c.recordEvent(tx, seat.ID, "meeting.seat_"+stance, meetingID, map[string]any{"draft": d.seq})
}
