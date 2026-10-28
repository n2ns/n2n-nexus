// Package store is the host's only storage: one SQLite file, schema managed by
// the numbered migrations in migrations/ (version in PRAGMA user_version), one
// transaction per write. The core and agents packages own their tables and
// queries; this package opens the database and runs the migrations.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

// FileName is the database file in the data directory.
const FileName = "nexus.db"

// Store is the open database.
type Store struct {
	DB *sql.DB
}

// Open opens (creating if needed) <dataDir>/nexus.db and migrates it to the latest version.
func Open(dataDir string) (*Store, error) {
	// A URI: escape the path so '#', '%', '?' in a directory name stay part of it.
	dsn := "file:" + (&url.URL{Path: filepath.ToSlash(filepath.Join(dataDir, FileName))}).EscapedPath() +
		"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: SQLite has one writer, and a single connection keeps
	// every transaction strictly ordered without SQLITE_BUSY between our own goroutines.
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.DB.Close() }

// Tx runs fn in one transaction: committed when fn returns nil, rolled back otherwise.
func (s *Store) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ISO formats t like JavaScript's toISOString (UTC, milliseconds), the format stored in every timestamp column.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// ParseISO parses a timestamp written by ISO.
func ParseISO(s string) (time.Time, error) { return time.Parse("2006-01-02T15:04:05.000Z", s) }

type migration struct {
	version int
	name    string
}

func (s *Store) migrate() error {
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return err
	}
	var list []migration
	for _, e := range entries {
		n, err := strconv.Atoi(strings.SplitN(e.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with its version number", e.Name())
		}
		list = append(list, migration{n, e.Name()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].version < list[j].version })

	var current int
	if err := s.DB.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	for i, m := range list {
		if m.version != i+1 {
			return fmt.Errorf("migrations must be numbered 1, 2, 3...: found %s", m.name)
		}
		if m.version <= current {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + m.name)
		if err != nil {
			return err
		}
		err = s.Tx(context.Background(), func(tx *sql.Tx) error {
			if _, err := tx.Exec(string(body)); err != nil {
				return fmt.Errorf("migration %s: %w", m.name, err)
			}
			_, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.version))
			return err
		})
		if err != nil {
			return err
		}
	}
	if current > len(list) {
		return fmt.Errorf("database version %d does not match this host (%d): upgrade n2n-nexus-host, or delete %s when the CHANGELOG of this release says to reset the data directory", current, len(list), FileName)
	}
	return nil
}
