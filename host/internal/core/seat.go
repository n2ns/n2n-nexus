package core

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

// The user's seat: one session of a meeting acts for the user. Its stance on
// the current draft decides it (endorse: the host posts the DECISION; object:
// the draft is void), only it ends the meeting, and consensus of the others
// decides nothing. The seat moves to whichever session takes it last.

// maxStanceChanges is how often a member may change its stance on one proposal.
const maxStanceChanges = 2

// seatOf is the session that holds the meeting's seat, or "".
func seatOf(tx *sql.Tx, meetingID string) (string, error) {
	var seat sql.NullString
	err := tx.QueryRow(`SELECT seat_member_id FROM meetings WHERE id = ?`, meetingID).Scan(&seat)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return seat.String, err
}

// takeSeat gives the meeting's seat to who and posts the change; it reports
// whether it posted (not when who holds the seat already).
func (c *Core) takeSeat(tx *sql.Tx, meetingID string, who api.Identity) (bool, error) {
	if who.Kind != api.IdentitySession {
		return false, api.Errorf("The user's seat is taken by a conversation with the n2n-nexus hooks; this call acts as adapter instance %s.", who.ID)
	}
	old, err := seatOf(tx, meetingID)
	if err != nil || old == who.ID {
		return false, err
	}
	if _, err := tx.Exec(`UPDATE meetings SET seat_member_id = ? WHERE id = ?`, who.ID, meetingID); err != nil {
		return false, err
	}
	texts := c.d.Contract.Hook.Texts
	to, err := memberLabel(tx, meetingID, who.ID)
	if err != nil {
		return false, err
	}
	text := fmt.Sprintf(texts.SeatTaken, to)
	if old != "" {
		from, err := memberLabel(tx, meetingID, old)
		if err != nil {
			return false, err
		}
		text = fmt.Sprintf(texts.SeatMoved, from, to)
	}
	if _, err := c.addMeetingMessage(tx, meetingID, consensusSender, text, "UPDATE"); err != nil {
		return false, err
	}
	if err := c.recordEvent(tx, who.ID, "meeting.seat", meetingID, map[string]any{"from": old}); err != nil {
		return false, err
	}
	// Who counts for the AI consensus changed with the seat.
	_, _, err = c.checkConsensus(tx, meetingID, who.ID)
	return true, err
}

// memberLabel is how host messages name a member: "name (id)" with the name
// it had when it joined, or the id.
func memberLabel(tx *sql.Tx, meetingID, id string) (string, error) {
	var name sql.NullString
	err := tx.QueryRow(`SELECT name FROM meeting_members WHERE meeting_id = ? AND member_id = ?`, meetingID, id).Scan(&name)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if name.String == "" {
		return id, nil
	}
	return fmt.Sprintf("%s (%s)", name.String, id), nil
}

var (
	evidenceRef = regexp.MustCompile(`#(\d+)`)
	evidenceURL = regexp.MustCompile(`https?://\S+`)
	// A file path: a name with an extension, a path from ~/, ./ or /, or three segments with letters (not 1/2 or and/or).
	evidencePath = regexp.MustCompile(`[\p{L}\p{N}_-]+\.[A-Za-z][A-Za-z0-9]{1,4}(?:[^A-Za-z0-9]|$)` +
		`|(?:^|\s)(?:~|\.{1,2})?[/\\][\p{L}\p{N}_.-]` +
		`|[\p{L}_.-][\p{L}\p{N}_.-]*[/\\][\p{L}_.-][\p{L}\p{N}_.-]*[/\\][\p{L}\p{N}_.-]`)
	evidenceLine = regexp.MustCompile(`(?:^|[.。!?！？\n]\s*)(?:实测|文档|数据|Measured|Docs|Data)\s*[:：]`)
)

// checkEvidence requires a note to point at something that can be checked:
// a message of this meeting (#n), a file path, a URL, or a sentence starting
// with 实测：/文档：/数据： (Measured:/Docs:/Data:). Only the form is checked.
func checkEvidence(tx *sql.Tx, meetingID, note string) error {
	if evidenceURL.MatchString(note) || evidencePath.MatchString(note) || evidenceLine.MatchString(note) {
		return nil
	}
	var missing []string
	for _, m := range evidenceRef.FindAllStringSubmatch(note, -1) {
		seq, _ := strconv.ParseInt(m[1], 10, 64)
		var one int
		err := tx.QueryRow(`SELECT 1 FROM meeting_messages WHERE meeting_id = ? AND seq = ?`, meetingID, seq).Scan(&one)
		if err == nil {
			return nil
		}
		if err != sql.ErrNoRows {
			return err
		}
		missing = append(missing, m[0])
	}
	hint := ""
	if len(missing) > 0 {
		hint = fmt.Sprintf(" (%v are not messages of this meeting)", missing)
	}
	return api.Errorf("An objection or a changed stance needs its grounds in the note: #n of a message of this meeting%s, a file path, a URL, or a sentence starting with 实测：/文档：/数据： (Measured:/Docs:/Data:).", hint)
}
