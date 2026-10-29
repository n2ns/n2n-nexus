package core

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

func notFoundMeeting(id string) error { return api.Errorf("Meeting '%s' not found.", id) }

func meetingExists(tx *sql.Tx, id string) (bool, error) {
	var one int
	err := tx.QueryRow(`SELECT 1 FROM meetings WHERE id = ?`, id).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// defaultMeetingID is the active default meeting, or "".
func defaultMeetingID(tx *sql.Tx) (string, error) {
	var id string
	err := tx.QueryRow(`SELECT id FROM meetings WHERE is_default = 1 AND status = 'active'`).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

// makeDefault makes id the default meeting (id "" leaves none).
func makeDefault(tx *sql.Tx, id string) error {
	if _, err := tx.Exec(`UPDATE meetings SET is_default = 0 WHERE is_default = 1`); err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	_, err := tx.Exec(`UPDATE meetings SET is_default = 1 WHERE id = ?`, id)
	return err
}

var (
	nonSlug   = regexp.MustCompile(`[^a-z0-9]+`)
	nonAlnum  = regexp.MustCompile(`[^a-zA-Z0-9]`)
	slugTrims = regexp.MustCompile(`^-|-$`)
)

// meetingID is <yyyyMMddHHmmss>-<slug of the topic>-<random>; a topic
// without ASCII letters or digits gets a slug from its base64 form.
func meetingID(topic string, now time.Time) string {
	slug := slugTrims.ReplaceAllString(nonSlug.ReplaceAllString(strings.ToLower(topic), "-"), "")
	if len(slug) > 30 {
		slug = slug[:30]
	}
	if slug == "" {
		slug = nonAlnum.ReplaceAllString(base64.StdEncoding.EncodeToString([]byte(topic)), "")
		if len(slug) > 8 {
			slug = slug[:8]
		}
		slug = strings.ToLower(slug)
	}
	if slug == "" {
		slug = "meeting"
	}
	return compactTime(now) + "-" + slug + "-" + randomSuffix()
}

type meetingRow struct {
	status string
	topic  string
}

func loadMeeting(tx *sql.Tx, id string) (meetingRow, error) {
	var m meetingRow
	err := tx.QueryRow(`SELECT status, topic FROM meetings WHERE id = ?`, id).Scan(&m.status, &m.topic)
	if err == sql.ErrNoRows {
		return m, notFoundMeeting(id)
	}
	return m, err
}

// ---------------------------------------------------------------------------
// start_meeting

type startMeetingArgs struct {
	Topic string `json:"topic"`
	// Seat "user": the caller takes the user's seat.
	Seat string `json:"seat"`
}

func (c *Core) startMeeting(call api.Call, a startMeetingArgs) (any, error) {
	now := c.d.Clock.Now()
	id := meetingID(a.Topic, now)
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	participants, _ := json.Marshal([]string{who.ID})
	err = c.tx(call, func(tx *sql.Tx) error {
		if err := makeDefault(tx, ""); err != nil {
			return err
		}
		if _, err := tx.Exec(`
			INSERT INTO meetings (id, topic, status, is_default, active_order, initiator, participants, created_at)
			VALUES (?, ?, 'active', 1, (SELECT COALESCE(MAX(active_order), 0) + 1 FROM meetings), ?, ?, ?)`,
			id, a.Topic, who.ID, string(participants), c.now()); err != nil {
			return err
		}
		// The initiator takes part as an active member whose approval is required.
		if _, err := tx.Exec(`INSERT INTO meeting_members (meeting_id, member_id, identity_kind, mode, approver, joined_at, name, title, machine)
			VALUES (?, ?, ?, 'active', 'required', ?, `+snapshotName+`, `+snapshotTitle+`, `+snapshotMachine+`)`,
			id, who.ID, who.Kind, c.now(), who.ID, who.ID, who.ID); err != nil {
			return err
		}
		if err := c.recordEvent(tx, who.ID, "meeting.start", id, map[string]any{"topic": a.Topic}); err != nil {
			return err
		}
		if a.Seat == "" {
			return nil
		}
		_, err := c.takeSeat(tx, id, who)
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "meetingId": id, "topic": a.Topic, "status": "active"}, nil
}

// ---------------------------------------------------------------------------
// end_meeting

type endMeetingArgs struct {
	MeetingID string  `json:"meetingId"`
	Summary   *string `json:"summary"`
}

func (c *Core) endMeeting(call api.Call, a endMeetingArgs) (any, error) {
	id := a.MeetingID
	summary := ""
	if a.Summary != nil {
		summary = *a.Summary
	}
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	// proposal is the message an end_meeting by another than the seat posted.
	var proposal int64
	err = c.tx(call, func(tx *sql.Tx) error {
		if id == "" {
			var err error
			if id, err = defaultMeetingID(tx); err != nil {
				return err
			}
			if id == "" {
				return api.Errorf("No active meeting found to end.")
			}
		}
		m, err := loadMeeting(tx, id)
		if err != nil {
			return err
		}
		if m.status != "active" {
			return api.Errorf("Meeting '%s' is already %s.", id, m.status)
		}
		// With the user's seat, only the seat ends the meeting; anyone else proposes it.
		seat, err := seatOf(tx, id)
		if err != nil {
			return err
		}
		if seat != "" && seat != who.ID {
			reason := summary
			if strings.TrimSpace(reason) == "" {
				reason = "(no summary)"
			}
			text := fmt.Sprintf(c.d.Contract.Hook.Texts.ProposedEnd, reason)
			if proposal, err = c.addMeetingMessage(tx, id, who.ID, text, "CHAT"); err != nil {
				return err
			}
			return nil
		}
		if seat != "" && strings.TrimSpace(summary) == "" {
			return api.Errorf("The user's seat ends a meeting with a summary: what was decided, what was not (\"open: point k\"), and who does what next.")
		}
		if err := c.closeMeeting(tx, id, nullString(summary), "manual"); err != nil {
			return err
		}
		detail := map[string]any{"topic": m.topic}
		if a.Summary != nil {
			detail["summary"] = *a.Summary
		}
		return c.recordEvent(tx, who.ID, "meeting.end", id, detail)
	})
	if err != nil {
		return nil, err
	}
	if proposal != 0 {
		c.afterMeetingChange(id, who.ID, true, false)
		return map[string]any{"ok": false, "refused": true, "meetingId": id, "status": "active", "messageId": proposal,
			"message": fmt.Sprintf("Only the user's seat ends meeting %s; your end_meeting was posted as message #%d proposing it.", id, proposal)}, nil
	}
	if c.d.Meetings != nil {
		c.d.Meetings.MeetingClosed(id, who.ID)
	}
	result := map[string]any{"ok": true, "meetingId": id, "status": "closed"}
	if summary != "" {
		result["summary"] = summary
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// archive_meeting, reopen_meeting

type meetingIDArgs struct {
	MeetingID string `json:"meetingId"`
}

func (c *Core) archiveMeeting(call api.Call, a meetingIDArgs) (any, error) {
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	err = c.tx(call, func(tx *sql.Tx) error {
		m, err := loadMeeting(tx, a.MeetingID)
		if err != nil {
			return err
		}
		if m.status == "active" {
			return api.Errorf("Meeting '%s' is still active. End it first.", a.MeetingID)
		}
		if _, err := tx.Exec(`UPDATE meetings SET status = 'archived' WHERE id = ?`, a.MeetingID); err != nil {
			return err
		}
		return c.recordEvent(tx, who.ID, "meeting.archive", a.MeetingID, nil)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "meetingId": a.MeetingID, "status": "archived"}, nil
}

func (c *Core) reopenMeeting(call api.Call, a meetingIDArgs) (any, error) {
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	err = c.tx(call, func(tx *sql.Tx) error {
		m, err := loadMeeting(tx, a.MeetingID)
		if err != nil {
			return err
		}
		if m.status == "active" {
			return api.Errorf("Meeting '%s' is already active.", a.MeetingID)
		}
		// The draft was settled or abandoned when the meeting ended: a reopened meeting needs a new one.
		if _, err := tx.Exec(`UPDATE meetings SET status = 'active', closed_at = NULL, end_reason = NULL, current_proposal_id = NULL,
			active_order = (SELECT MAX(active_order) + 1 FROM meetings), reopened_at = ? WHERE id = ?`, c.now(), a.MeetingID); err != nil {
			return err
		}
		if err := makeDefault(tx, a.MeetingID); err != nil {
			return err
		}
		return c.recordEvent(tx, who.ID, "meeting.reopen", a.MeetingID, nil)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "meetingId": a.MeetingID, "status": "active"}, nil
}

// ---------------------------------------------------------------------------
// list_meetings

type listMeetingsArgs struct {
	Status string `json:"status"`
	Limit  int    `json:"limit"`
}

type meetingSummary struct {
	ID            string          `json:"id"`
	Topic         string          `json:"topic"`
	Status        string          `json:"status"`
	Initiator     string          `json:"initiator"`
	StartTime     string          `json:"startTime"`
	EndTime       string          `json:"endTime,omitempty"`
	Participants  json.RawMessage `json:"participants"`
	MessageCount  int64           `json:"messageCount"`
	DecisionCount int64           `json:"decisionCount"`
	Summary       string          `json:"summary,omitempty"`
	// Wakes is the number of wakes the meeting caused, members that left included.
	Wakes   int64           `json:"wakes"`
	Members []meetingMember `json:"members"`
	// EndReason is manual, consensus or expired for a meeting that ended, else null.
	EndReason *string `json:"endReason"`
	// Seat is the session holding the user's seat, null in a meeting without one.
	Seat *string `json:"seat"`
	// Proposal is the current draft and its approvals; null when none was published.
	Proposal *proposalSummary `json:"proposal"`
}

// proposalSummary is a meeting's current draft: its number, author, the
// version of its approver list and its approvals.
type proposalSummary struct {
	MessageID        int64  `json:"messageId"`
	Author           string `json:"author"`
	ApproversVersion int64  `json:"approversVersion"`
	approvals
}

// meetingMember is a member that has not left. Name and Status are the
// session's, null for an instance member.
type meetingMember struct {
	ID    string  `json:"id"`
	Name  *string `json:"name"`
	Title *string `json:"title"`
	// Machine, like Name and Title, is the session as it was when it joined; Backfilled: filled in when the database was upgraded.
	Machine     *string `json:"machine"`
	Backfilled  bool    `json:"backfilled"`
	Mode        string  `json:"mode"`
	Approver    string  `json:"approver"`
	Status      *string `json:"status"`
	JoinedAt    string  `json:"joinedAt"`
	Wakes       int64   `json:"wakes"`
	LastWokenAt *string `json:"lastWokenAt"`
}

// loadMembers lists the members of a meeting that have not left, in the order they joined.
func loadMembers(tx *sql.Tx, meetingID string) ([]meetingMember, error) {
	rows, err := tx.Query(`
		SELECT mm.member_id, mm.name, mm.title, mm.machine, mm.snapshot_backfilled, mm.mode, mm.approver, s.status, mm.joined_at, mm.wakes, mm.last_woken_at
		FROM meeting_members mm LEFT JOIN agent_sessions s ON s.id = mm.member_id
		WHERE mm.meeting_id = ? AND mm.left_at IS NULL
		ORDER BY mm.joined_at, mm.rowid`, meetingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []meetingMember{}
	for rows.Next() {
		var m meetingMember
		var name, title, machine, status, woken sql.NullString
		if err := rows.Scan(&m.ID, &name, &title, &machine, &m.Backfilled, &m.Mode, &m.Approver, &status, &m.JoinedAt, &m.Wakes, &woken); err != nil {
			return nil, err
		}
		m.Name, m.Title, m.Machine, m.Status, m.LastWokenAt = nullable(name), nullable(title), nullable(machine), nullable(status), nullable(woken)
		members = append(members, m)
	}
	return members, rows.Err()
}

func nullable(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func (c *Core) listMeetings(call api.Call, a listMeetingsArgs) (any, error) {
	meetings := []meetingSummary{}
	var active string
	err := c.tx(call, func(tx *sql.Tx) error {
		rows, err := tx.Query(`
			SELECT m.id, m.topic, m.status, m.initiator, m.participants, m.created_at, m.closed_at, m.summary, m.end_reason, m.seat_member_id,
				(SELECT COUNT(*) FROM meeting_messages WHERE meeting_id = m.id),
				(SELECT COUNT(*) FROM decisions WHERE meeting_id = m.id),
				(SELECT COALESCE(SUM(wakes), 0) FROM meeting_members WHERE meeting_id = m.id)
			FROM meetings m
			WHERE ? = '' OR m.status = ?
			ORDER BY m.created_at DESC, m.rowid DESC
			LIMIT ?`, a.Status, a.Status, a.Limit)
		if err != nil {
			return err
		}
		for rows.Next() {
			var m meetingSummary
			var participants string
			var closed, summary, reason, seat sql.NullString
			if err := rows.Scan(&m.ID, &m.Topic, &m.Status, &m.Initiator, &participants, &m.StartTime, &closed, &summary, &reason, &seat,
				&m.MessageCount, &m.DecisionCount, &m.Wakes); err != nil {
				rows.Close()
				return err
			}
			m.Participants = json.RawMessage(participants)
			m.EndTime, m.Summary, m.EndReason, m.Seat = closed.String, summary.String, nullable(reason), nullable(seat)
			meetings = append(meetings, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for i := range meetings {
			if meetings[i].Members, err = loadMembers(tx, meetings[i].ID); err != nil {
				return err
			}
			d, ok, err := currentDraft(tx, meetings[i].ID)
			if err != nil {
				return err
			}
			if ok {
				p := &proposalSummary{MessageID: d.seq, Author: d.author, ApproversVersion: d.version}
				if p.approvals, err = loadApprovals(tx, meetings[i].ID, d.row, true); err != nil {
					return err
				}
				meetings[i].Proposal = p
			}
		}
		active, err = defaultMeetingID(tx)
		return err
	})
	if err != nil {
		return nil, err
	}
	var activeID any
	if active != "" {
		activeID = active
	}
	return map[string]any{"count": len(meetings), "activeMeetingId": activeID, "meetings": meetings}, nil
}

// ---------------------------------------------------------------------------
// join_meeting, leave_meeting

type joinMeetingArgs struct {
	MeetingID string `json:"meetingId"`
	Mode      string `json:"mode"`
	Approver  string `json:"approver"`
	// Since is "beginning", "latest" or a message number in the meeting; nil keeps the read cursor.
	Since json.RawMessage `json:"since"`
	// Seat "user": the caller takes the user's seat.
	Seat string `json:"seat"`
}

func (c *Core) joinMeeting(call api.Call, a joinMeetingArgs) (any, error) {
	if a.Approver == "" {
		a.Approver = map[string]string{"active": "required", "async": "optional"}[a.Mode]
	}
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	var posted, decided bool
	err = c.tx(call, func(tx *sql.Tx) error {
		m, err := loadMeeting(tx, a.MeetingID)
		if err != nil {
			return err
		}
		if m.status != "active" {
			return api.Errorf("Meeting '%s' is %s, cannot join.", a.MeetingID, m.status)
		}
		newest, err := sourceOf(a.MeetingID).maxID(tx)
		if err != nil {
			return err
		}
		var eligible bool
		var leftAt sql.NullString
		err = tx.QueryRow(`SELECT draft_eligible, left_at FROM meeting_members WHERE meeting_id = ? AND member_id = ?`,
			a.MeetingID, who.ID).Scan(&eligible, &leftAt)
		first := err == sql.ErrNoRows
		if err != nil && !first {
			return err
		}
		// Only a member that has not left can change its place in the current draft's approver list.
		member := !first && !leftAt.Valid
		since := a.Since
		if since == nil && first {
			since = json.RawMessage(`"latest"`)
		}
		if since != nil {
			cursor, err := sinceCursor(tx, a.MeetingID, since, newest)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`
				INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES (?, 'meeting', ?, ?, ?)
				ON CONFLICT (instance_id, context_type, context_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
				who.ID, a.MeetingID, cursor, c.now()); err != nil {
				return err
			}
		}
		// Messages from before the join are not announced to the member; a member
		// that only changes how it takes part keeps what it was told, when it
		// joined and how it was then, while one that comes back after leaving joins anew.
		if _, err := tx.Exec(`
			INSERT INTO meeting_members (meeting_id, member_id, identity_kind, mode, approver, joined_at, notified_id, name, title, machine)
			VALUES (?, ?, ?, ?, ?, ?, ?, `+snapshotName+`, `+snapshotTitle+`, `+snapshotMachine+`)
			ON CONFLICT (meeting_id, member_id) DO UPDATE SET mode = excluded.mode, approver = excluded.approver,
				identity_kind = excluded.identity_kind,
				name = CASE WHEN left_at IS NULL THEN name ELSE excluded.name END,
				title = CASE WHEN left_at IS NULL THEN title ELSE excluded.title END,
				machine = CASE WHEN left_at IS NULL THEN machine ELSE excluded.machine END,
				snapshot_backfilled = CASE WHEN left_at IS NULL THEN snapshot_backfilled ELSE 0 END,
				draft_eligible = CASE WHEN left_at IS NULL THEN draft_eligible ELSE 0 END,
				notified_id = CASE WHEN left_at IS NULL THEN notified_id ELSE excluded.notified_id END,
				joined_at = CASE WHEN left_at IS NULL THEN joined_at ELSE excluded.joined_at END, left_at = NULL`,
			a.MeetingID, who.ID, who.Kind, a.Mode, a.Approver, c.now(), newest, who.ID, who.ID, who.ID); err != nil {
			return err
		}
		if err := c.recordEvent(tx, who.ID, "meeting.join", a.MeetingID, map[string]any{"mode": a.Mode, "approver": a.Approver}); err != nil {
			return err
		}
		if a.Seat != "" {
			if posted, err = c.takeSeat(tx, a.MeetingID, who); err != nil {
				return err
			}
		}
		if !member {
			return nil // a new member is not an approver of a draft published before it joined
		}
		d, ok, err := currentDraft(tx, a.MeetingID)
		if err != nil || !ok {
			return err
		}
		listed, err := isApprover(tx, a.MeetingID, who.ID)
		if err != nil {
			return err
		}
		switch {
		case listed && (a.Approver == "optional" || who.Kind != api.IdentitySession):
			_, err = tx.Exec(`DELETE FROM meeting_approvers WHERE meeting_id = ? AND member_id = ?`, a.MeetingID, who.ID)
		case a.Approver == "required" && !listed && who.Kind == api.IdentitySession && eligible:
			_, err = tx.Exec(`INSERT INTO meeting_approvers (meeting_id, member_id) VALUES (?, ?)`, a.MeetingID, who.ID)
		default:
			return nil
		}
		if err != nil {
			return err
		}
		var told bool
		told, decided, err = c.approversChanged(tx, a.MeetingID, who.ID, d)
		posted = posted || told
		return err
	})
	if err != nil {
		return nil, err
	}
	c.afterMeetingChange(a.MeetingID, who.ID, posted, decided)
	// An instance has no hooks, so nothing can notify it.
	delivery := "unavailable"
	if who.Kind == api.IdentitySession {
		delivery = map[string]string{"active": "wake", "async": "next-hook"}[a.Mode]
	}
	return map[string]any{"ok": true, "meetingId": a.MeetingID, "mode": a.Mode, "approver": a.Approver,
		"identity": who.Kind, "delivery": delivery}, nil
}

// sinceCursor is the read cursor (a table id) for since: 0 for "beginning",
// newest for "latest", the table id of message number N for N.
func sinceCursor(tx *sql.Tx, meetingID string, since json.RawMessage, newest int64) (int64, error) {
	var word string
	if string(since) == "0" {
		return 0, nil // after message 0: from the beginning
	}
	if json.Unmarshal(since, &word) == nil {
		if word == "beginning" {
			return 0, nil
		}
		return newest, nil
	}
	var seq int64
	if err := json.Unmarshal(since, &seq); err != nil {
		return 0, api.Errorf("Invalid since: %s", since)
	}
	var row int64
	err := tx.QueryRow(`SELECT id FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, seq).Scan(&row)
	if err == sql.ErrNoRows {
		return 0, api.Errorf("Meeting '%s' has no message %d.", meetingID, seq)
	}
	return row, err
}

func (c *Core) leaveMeeting(call api.Call, a meetingIDArgs) (any, error) {
	who, err := c.identity(call)
	if err != nil {
		return nil, err
	}
	var posted, decided bool
	err = c.tx(call, func(tx *sql.Tx) error {
		if _, err := loadMeeting(tx, a.MeetingID); err != nil {
			return err
		}
		n, err := exec(tx, `UPDATE meeting_members SET left_at = ?, draft_eligible = 0 WHERE meeting_id = ? AND member_id = ? AND left_at IS NULL`,
			c.now(), a.MeetingID, who.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return api.Errorf("%s is not a member of meeting '%s'.", who.ID, a.MeetingID)
		}
		if err := c.recordEvent(tx, who.ID, "meeting.leave", a.MeetingID, nil); err != nil {
			return err
		}
		d, ok, err := currentDraft(tx, a.MeetingID)
		if err != nil || !ok {
			return err
		}
		// A member that leaves is no longer an approver of the current draft.
		if n, err = exec(tx, `DELETE FROM meeting_approvers WHERE meeting_id = ? AND member_id = ?`, a.MeetingID, who.ID); err != nil || n == 0 {
			return err
		}
		posted, decided, err = c.approversChanged(tx, a.MeetingID, who.ID, d)
		return err
	})
	if err != nil {
		return nil, err
	}
	c.afterMeetingChange(a.MeetingID, who.ID, posted, decided)
	return map[string]any{"ok": true, "meetingId": a.MeetingID}, nil
}

func isApprover(tx *sql.Tx, meetingID, memberID string) (bool, error) {
	var one int
	err := tx.QueryRow(`SELECT 1 FROM meeting_approvers WHERE meeting_id = ? AND member_id = ?`, meetingID, memberID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
