package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/host"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func tarProgram(t *testing.T, script string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	w := tar.NewWriter(gz)
	if err := w.WriteHeader(&tar.Header{Name: "./n2n-nexus-host", Mode: 0755, Size: int64(len(script))}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(w, script); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func infoScript(t *testing.T, b Build) string {
	t.Helper()
	data, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	return "#!/bin/sh\n[ \"$1 $2\" = 'auto-update info' ] || exit 77\nprintf '%s\\n' '" + string(data) + "'\n"
}
func TestArchiveUpdate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX executables")
	}
	old, err := LocalBuild("1.2.9")
	if err != nil {
		t.Fatal(err)
	}
	if old.Contract == 0 || len(old.Schema) != 64 {
		t.Fatal(old)
	}
	newer := old
	newer.Version = "1.2.10"
	for _, tc := range []struct {
		name      string
		wantError string
	}{
		{"install and verify", ""}, {"integrity", "SHA256SUMS"}, {"provenance", "build provenance"},
		{"database", "coordinated upgrade"}, {"contract", "coordinated upgrade"}, {"wrong binary", "disagrees"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, bin := t.TempDir(), t.TempDir()
			t.Setenv("XDG_CACHE_HOME", t.TempDir())
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			exe := filepath.Join(bin, "n2n-nexus-host")
			script := infoScript(t, old)
			if err := os.WriteFile(exe, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			gh := "#!/bin/sh\n[ \"$1 $2\" = 'attestation verify' ] && [ \"$7\" = 'n2ns/n2n-nexus/.github/workflows/host-release.yml' ] && [ \"$9\" = 'refs/tags/host-v1.2.10' ]\n"
			if tc.name == "provenance" {
				gh = "#!/bin/sh\nexit 2\n"
			}
			if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(gh), 0700); err != nil {
				t.Fatal(err)
			}
			target := newer
			switch tc.name {
			case "database":
				target.Schema = strings.Repeat("1", 64)
			case "contract":
				target.Contract++
			}
			payload := newer
			if tc.name == "wrong binary" {
				payload.Version = "1.2.11"
			}
			content := tarProgram(t, infoScript(t, payload))
			digest := fmt.Sprintf("%x", sha256.Sum256(content))
			if tc.name == "integrity" {
				digest = "bad"
			}
			data, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			name := archiveName(target.Version)
			fixtures := map[string][]byte{
				"/repos/n2ns/n2n-nexus/releases":                             []byte(`[{"tag_name":"host-v1.2.9"},{"tag_name":"host-v1.2.10"},{"tag_name":"v10.0.0"},{"tag_name":"host-v11.0.0","prerelease":true},{"tag_name":"host-v12.0.0","draft":true}]`),
				"/n2ns/n2n-nexus/releases/download/host-v1.2.10/update.json": data,
				"/n2ns/n2n-nexus/releases/download/host-v1.2.10/SHA256SUMS":  []byte(digest + "  " + name + "\n"),
				"/n2ns/n2n-nexus/releases/download/host-v1.2.10/" + name:     content,
			}
			real := http.DefaultTransport
			http.DefaultTransport = transportFunc(func(r *http.Request) (*http.Response, error) {
				b, ok := fixtures[r.URL.Path]
				if !ok {
					return nil, fmt.Errorf("unexpected download: %q", r.URL)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b)), Header: make(http.Header), Request: r}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = real })
			var out bytes.Buffer
			err = run(t.Context(), exe, old.Version, root, "", &out)
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("got %v, want %q", err, tc.wantError)
				}
				unchanged, _ := os.ReadFile(exe)
				if string(unchanged) != script {
					t.Fatal("changed original on failure")
				}
				return
			}
			if err != nil || !strings.Contains(out.String(), "is stopped") {
				t.Fatalf("%v %s", err, out.String())
			}
			if disk, err := inspect(t.Context(), exe); err != nil || disk != newer {
				t.Fatalf("on disk: %+v %v", disk, err)
			}
		})
	}
}

func TestRunningHostMustConfirmVersion(t *testing.T) {
	root := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	build, err := LocalBuild("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"service":"n2n-nexus","version":"1.0.0"}`)
	}))
	defer srv.Close()
	lock, err := host.AcquireLock(root, 123, 10, host.RoleSupervised)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if err := host.RecordListener(root, strings.TrimPrefix(srv.URL, "http://"), exe, build.Version, build.Contract, build.Schema); err != nil {
		t.Fatal(err)
	}
	before, err := active(root, exe)
	if err != nil {
		t.Fatal(err)
	}
	target := build
	target.Version = "1.0.1"
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	err = activate(ctx, root, exe, target, before, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "did not confirm") {
		t.Fatalf("old service accepted: %v", err)
	}
	if _, err = os.Stat(filepath.Join(root, host.RestartRequestFile)); err != nil {
		t.Fatal(err)
	}
}
