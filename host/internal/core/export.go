package core

import (
	"database/sql"
	"fmt"
	"strings"
)

// exportMeeting writes a meeting as markdown: its state, members (left ones
// included), decisions and messages, each with who wrote it and where.
func exportMeeting(tx *sql.Tx, id string) (string, error) {
	var topic, status, created string
	var closed, summary, reason sql.NullString
	err := tx.QueryRow(`SELECT topic, status, created_at, closed_at, summary, end_reason FROM meetings WHERE id = ?`, id).
		Scan(&topic, &status, &created, &closed, &summary, &reason)
	if err == sql.ErrNoRows {
		return "", notFoundMeeting(id)
	}
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n- Meeting: %s\n- Status: %s", topic, id, status)
	if reason.Valid {
		fmt.Fprintf(&b, " (%s)", reason.String)
	}
	fmt.Fprintf(&b, "\n- Started: %s\n", created)
	if closed.Valid {
		fmt.Fprintf(&b, "- Ended: %s\n", closed.String)
	}
	if summary.Valid && summary.String != "" {
		fmt.Fprintf(&b, "- Summary: %s\n", summary.String)
	}
	backfilled := false

	b.WriteString("\n## Members\n\n")
	rows, err := tx.Query(`SELECT member_id, name, title, machine, snapshot_backfilled, joined_at, left_at
		FROM meeting_members WHERE meeting_id = ? ORDER BY joined_at, rowid`, id)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var member, joined string
		var name, title, machine, left sql.NullString
		var filled bool
		if err := rows.Scan(&member, &name, &title, &machine, &filled, &joined, &left); err != nil {
			rows.Close()
			return "", err
		}
		fmt.Fprintf(&b, "- %s", who(member, name, machine, filled))
		if title.String != "" {
			fmt.Fprintf(&b, " \"%s\"", title.String)
		}
		fmt.Fprintf(&b, ", joined %s", joined)
		if left.Valid {
			fmt.Fprintf(&b, ", left %s", left.String)
		}
		b.WriteString("\n")
		backfilled = backfilled || filled
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	rows, err = tx.Query(`SELECT content, timestamp FROM decisions WHERE meeting_id = ? ORDER BY id`, id)
	if err != nil {
		return "", err
	}
	first := true
	for rows.Next() {
		var content, at string
		if err := rows.Scan(&content, &at); err != nil {
			rows.Close()
			return "", err
		}
		if first {
			b.WriteString("\n## Decisions\n")
			first = false
		}
		fmt.Fprintf(&b, "\n### %s\n\n%s\n", at, content)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	messages, err := sourceOf(id).query(tx, "1", "ORDER BY m.id")
	if err != nil {
		return "", err
	}
	b.WriteString("\n## Messages\n")
	for _, m := range messages {
		fmt.Fprintf(&b, "\n### #%d %s · %s", m.ID, who(m.From, toNull(m.SenderName), toNull(m.SenderMachine), m.SenderBackfilled), m.Timestamp)
		if m.Category != nil {
			fmt.Fprintf(&b, " · %s", *m.Category)
		}
		fmt.Fprintf(&b, "\n\n%s\n", m.Text)
		backfilled = backfilled || m.SenderBackfilled
	}
	if backfilled {
		b.WriteString("\n---\n\n\\* Name and machine recorded when the database was upgraded, from the session as it was then, not when the member joined or the message was written.\n")
	}
	return b.String(), nil
}

// who is how the export shows a sender or member: "name (machine)", the id
// when no name was recorded, with * when the name was backfilled.
func who(id string, name, machine sql.NullString, backfilled bool) string {
	s := id
	if name.Valid {
		s = name.String
	}
	if machine.Valid {
		s += " (" + machine.String + ")"
	}
	if backfilled {
		s += "\\*"
	}
	return s
}
