// Package store is the host's only storage: one SQLite file, schema managed by
// the numbered migrations in migrations/ (version in PRAGMA user_version), one
// transaction per write. The core and agents packages own their tables and
// queries; this package opens the database and runs the migrations.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
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

// ErrDryRun, returned by a Tx function, rolls the transaction back: a dry run.
var ErrDryRun = errors.New("dry run")

// Affected is how many rows the statement that returned r and err changed.
func Affected(r sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// Exists reports whether row, of a SELECT 1 query, found a row.
func Exists(row *sql.Row) (bool, error) {
	var one int
	err := row.Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Append appends every row of rows, scanned with scan, to out and closes
// rows; err is the error of the query that returned rows.
func Append[T any](out []T, rows *sql.Rows, err error, scan func(*sql.Rows) (T, error)) ([]T, error) {
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ScanString scans a row of one text column.
func ScanString(rows *sql.Rows) (string, error) {
	var s string
	return s, rows.Scan(&s)
}

// ISO formats t like JavaScript's toISOString (UTC, milliseconds), the format stored in every timestamp column.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

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
	// Foreign keys are off while migrating, as SQLite requires for a migration
	// that rebuilds a table others refer to (dropping the old table would
	// otherwise cascade); each migration is checked before it commits.
	if _, err := s.DB.Exec("PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	defer s.DB.Exec("PRAGMA foreign_keys = ON")
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
				// On a database that was migrated by an older host the schema may
				// not be what this series expects (a release may restart it):
				// say how to reset it. On a fresh database it is a host defect.
				if current > 0 {
					return fmt.Errorf("migration %s: %w: the database was written by another version of n2n-nexus-host: delete %s when the CHANGELOG of this release says to reset the data directory", m.name, err, FileName)
				}
				return fmt.Errorf("migration %s: %w", m.name, err)
			}
			rows, err := tx.Query("PRAGMA foreign_key_check")
			if err != nil {
				return err
			}
			broken := rows.Next()
			rows.Close()
			if broken {
				return fmt.Errorf("migration %s leaves rows that break a foreign key", m.name)
			}
			_, err = tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.version))
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
