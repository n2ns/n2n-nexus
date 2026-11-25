// Package update installs compatible stable releases on the user's machine.
package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/version"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/n2ns/n2n-nexus/contract"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

const repository = "n2ns/n2n-nexus"
const releases = "https://github.com/" + repository + "/releases/download/host-v"

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// StableVersion reports whether a build is eligible for automatic updating.
func StableVersion(v string) bool { return stableVersion.MatchString(v) }

// Go and semver compare these strictly numeric three-component versions identically.
func compare(a, b string) int { return version.Compare("go"+a, "go"+b) }

type Build struct {
	Version  string `json:"version"`
	Contract int    `json:"contractVersion"`
	Schema   string `json:"migrationDigest"`
}

func LocalBuild(v string) (Build, error) {
	var b Build
	if err := json.Unmarshal(contract.ToolsJSON, &b); err != nil {
		return b, err
	}
	b.Version = v
	digest, err := store.MigrationDigest()
	b.Schema = digest
	return b, err
}
func (b Build) compatible(target Build) error {
	if b.Contract <= 0 || b.Contract != target.Contract || len(b.Schema) != 64 || b.Schema != target.Schema {
		return fmt.Errorf("version %s requires a coordinated upgrade (contract or database migrations differ); upgrade manually", target.Version)
	}
	return nil
}
func fetch(ctx context.Context, url string, out io.Writer, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 4 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return fmt.Errorf("response too large: %s", url)
	}
	return nil
}
func latest(ctx context.Context) (string, error) {
	best := ""
	for page := 1; ; page++ {
		var body strings.Builder
		if err := fetch(ctx, fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=100&page=%d", repository, page), &body, 16<<20); err != nil {
			return "", err
		}
		var list []struct {
			Tag               string `json:"tag_name"`
			Draft, Prerelease bool
		}
		if err := json.Unmarshal([]byte(body.String()), &list); err != nil {
			return "", err
		}
		for _, r := range list {
			v, ok := strings.CutPrefix(r.Tag, "host-v")
			if ok && !r.Draft && !r.Prerelease && stableVersion.MatchString(v) && (best == "" || compare(v, best) > 0) {
				best = v
			}
		}
		if len(list) < 100 {
			break
		}
	}
	if best == "" {
		return "", errors.New("no stable host release found")
	}
	return best, nil
}
func releaseBuild(ctx context.Context, v string) (Build, error) {
	var content strings.Builder
	var b Build
	if err := fetch(ctx, releases+v+"/update.json", &content, 8192); err != nil {
		return b, err
	}
	if err := json.Unmarshal([]byte(content.String()), &b); err != nil {
		return b, err
	}
	if b.Version != v {
		return b, fmt.Errorf("release metadata does not identify %s", v)
	}
	return b, nil
}
func archiveName(v string) string {
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("n2n-nexus-host_%s_%s_%s%s", v, runtime.GOOS, runtime.GOARCH, ext)
}
func verifyChecksum(list, name, digest string) error {
	for _, line := range strings.Split(list, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == name && fields[0] == digest {
			return nil
		}
	}
	return fmt.Errorf("SHA256SUMS does not match %s", name)
}
func downloadArchive(ctx context.Context, v, dir string) (string, error) {
	name := archiveName(v)
	var sums strings.Builder
	if err := fetch(ctx, releases+v+"/SHA256SUMS", &sums, 1<<20); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	err = fetch(ctx, releases+v+"/"+name, io.MultiWriter(f, hash), 128<<20)
	if err = errors.Join(err, f.Close()); err != nil {
		return "", err
	}
	if err = verifyChecksum(sums.String(), name, hex.EncodeToString(hash.Sum(nil))); err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, "gh", "attestation", "verify", path, "--repo", repository, "--signer-workflow", repository+"/.github/workflows/host-release.yml", "--source-ref", "refs/tags/host-v"+v)
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("verify GitHub build provenance for %s (requires gh attestation verify): %w", name, err)
	}
	return path, nil
}
func binaries() []string {
	if runtime.GOOS == "windows" {
		return []string{"n2n-nexus-host.exe", "n2n-nexus-host-tray.exe"}
	}
	return []string{"n2n-nexus-host"}
}

// extract installs only known regular files into a private staging directory.
func extract(archive, dir string, names []string) error {
	wanted := map[string]bool{}
	for _, name := range names {
		wanted[name] = true
	}
	write := func(name string, reader io.Reader) error {
		out, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, io.LimitReader(reader, (200<<20)+1))
		if n > 200<<20 {
			err = fmt.Errorf("%s too large", name)
		}
		delete(wanted, name)
		return errors.Join(err, out.Close())
	}
	if strings.HasSuffix(archive, ".zip") {
		z, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer z.Close()
		for _, member := range z.File {
			if !wanted[member.Name] || !member.Mode().IsRegular() {
				continue
			}
			r, err := member.Open()
			if err != nil {
				return err
			}
			err = write(member.Name, r)
			closeErr := r.Close()
			if err = errors.Join(err, closeErr); err != nil {
				return err
			}
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			name := strings.TrimPrefix(h.Name, "./")
			if !wanted[name] || h.Typeflag != tar.TypeReg {
				continue
			}
			if err = write(name, tr); err != nil {
				return err
			}
		}
	}
	for name := range wanted {
		return fmt.Errorf("archive is missing %s", name)
	}
	return nil
}
