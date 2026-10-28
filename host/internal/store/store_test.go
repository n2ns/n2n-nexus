package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The database lands in the data directory whatever characters its path holds.
func TestOpenPathWithURICharacters(t *testing.T) {
	names := []string{"hash#dir", "pct%41dir", "space dir"}
	if runtime.GOOS != "windows" { // Windows file names cannot hold '?'
		names = append(names, "q?dir")
	}
	for _, name := range names {
		dir := filepath.Join(t.TempDir(), name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		s, err := Open(dir)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		s.Close()
		if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
			t.Fatalf("%s: database not in the data directory: %v", name, err)
		}
	}
}
