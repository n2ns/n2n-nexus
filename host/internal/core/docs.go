package core

import (
	"database/sql"
	"fmt"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

func (c *Core) getGlobalStrategy(call api.Call, _ struct{}) (any, error) {
	var content string
	err := c.tx(call, func(tx *sql.Tx) error {
		// The row is created by the migration with the placeholder text.
		return tx.QueryRow(`SELECT content FROM global_strategy WHERE id = 1`).Scan(&content)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"content": content}, nil
}

type strategyArgs struct {
	Content string `json:"content"`
}

func (c *Core) updateGlobalStrategy(call api.Call, a strategyArgs) (any, error) {
	err := c.tx(call, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`
			INSERT INTO global_strategy (id, content, updated_at) VALUES (1, ?, ?)
			ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`, a.Content, c.now()); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "strategy.update", "", nil)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "message": "Global strategy updated."}, nil
}

type docEntry struct {
	DocID       string `json:"docId"`
	Title       string `json:"title"`
	LastUpdated string `json:"lastUpdated"`
	UpdatedBy   string `json:"updatedBy"`
}

func (c *Core) listGlobalDocs(call api.Call, _ struct{}) (any, error) {
	docs := []docEntry{}
	err := c.tx(call, func(tx *sql.Tx) error {
		// Newest first; documents updated at the same instant in the order they were created.
		rows, err := tx.Query(`SELECT id, title, updated_at, updated_by FROM global_docs ORDER BY updated_at DESC, rowid`)
		docs, err = store.Append(docs, rows, err, func(rows *sql.Rows) (docEntry, error) {
			var d docEntry
			return d, rows.Scan(&d.DocID, &d.Title, &d.LastUpdated, &d.UpdatedBy)
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": len(docs), "docs": docs}, nil
}

type docIDArgs struct {
	DocID string `json:"docId"`
}

func (c *Core) getGlobalDoc(call api.Call, a docIDArgs) (any, error) {
	var d docEntry
	var content string
	err := c.tx(call, func(tx *sql.Tx) error {
		err := tx.QueryRow(`SELECT id, title, updated_at, updated_by, content FROM global_docs WHERE id = ?`, a.DocID).
			Scan(&d.DocID, &d.Title, &d.LastUpdated, &d.UpdatedBy, &content)
		if err == sql.ErrNoRows {
			return api.Errorf("Document '%s' not found.", a.DocID)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"docId": d.DocID, "title": d.Title, "lastUpdated": d.LastUpdated, "updatedBy": d.UpdatedBy, "content": content}, nil
}

type syncDocArgs struct {
	DocID   string `json:"docId"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

func (c *Core) syncGlobalDoc(call api.Call, a syncDocArgs) (any, error) {
	err := c.tx(call, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`
			INSERT INTO global_docs (id, title, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET title = excluded.title, content = excluded.content,
				updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
			a.DocID, a.Title, a.Content, c.now(), call.Actor()); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "doc.sync", a.DocID, map[string]any{"title": a.Title})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "message": fmt.Sprintf("Global document '%s' (%s) synchronized.", a.Title, a.DocID)}, nil
}
