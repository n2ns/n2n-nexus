package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gofrs/flock"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/program"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// Run updates the installation from which it was invoked, preserving the host's
// running/stopped state. Nothing remote is accepted as an installation path.
func Run(ctx context.Context, v, root, method string, startup bool, out io.Writer) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if startup {
		self, _ = program.Invoked(self, os.Args[0])
	}
	return run(ctx, self, v, root, method, startup, out)
}

func run(ctx context.Context, self, v, root, method string, startup bool, out io.Writer) error {
	if !StableVersion(v) {
		return fmt.Errorf("only stable release installations can update (this build: %s)", v)
	}
	var err error
	exe, detected := program.Stable(self)
	exe = program.Console(exe)
	if filepath.Base(exe) != binaries()[0] || detected == "" {
		return fmt.Errorf("unsupported installation: %s", exe)
	}
	if method == "" {
		method = detected
	}
	if method != detected {
		return fmt.Errorf("--method %s does not match installation %s (%s)", method, exe, detected)
	}
	if root == "" {
		root, err = service.UpdateRoot(exe)
		if err != nil {
			return err
		}
	}
	lock := installationLock(exe, method)
	var ok bool
	if startup {
		// Each starting host must eventually reconcile its own data directory.
		ok, err = lock.TryLockContext(ctx, 200*time.Millisecond)
	} else {
		ok, err = lock.TryLock()
	}
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("an update of this installation is already running")
	}
	defer lock.Unlock()
	current, err := LocalBuild(v)
	if err != nil {
		return err
	}
	// A preceding process may have replaced this binary before we obtained the lock.
	disk, err := inspect(ctx, exe)
	if err != nil {
		return err
	}
	if disk != current {
		if !startup || !StableVersion(disk.Version) || compare(disk.Version, v) <= 0 {
			return errors.New("the on-disk version changed; run update again")
		}
		if err := current.compatible(disk); err != nil {
			return err
		}
	}
	before, err := active(root, exe)
	if err != nil {
		return err
	}
	// Another updater may already have installed a compatible release. Activate
	// it for this listener without downloading it again or requiring the network.
	if startup && before.Held && before.Version != disk.Version {
		return activate(ctx, root, exe, disk, before, out)
	}
	if disk != current {
		fmt.Fprintf(out, "Host %s is already installed.\n", disk.Version)
		return nil
	}
	targetVersion, err := latest(ctx)
	if err != nil {
		return err
	}
	if compare(v, targetVersion) >= 0 {
		if before.Held && before.Version != v {
			return activate(ctx, root, exe, current, before, out)
		}
		fmt.Fprintf(out, "Host %s is current.\n", v)
		return nil
	}
	target, err := releaseBuild(ctx, targetVersion)
	if err != nil {
		return err
	}
	if err = current.compatible(target); err != nil {
		return err
	}
	if err = checkRunning(before, target); err != nil {
		return err
	}
	if method == "archive" {
		stage, err := os.MkdirTemp("", "n2n-nexus-host-update-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(stage)
		file, err := downloadArchive(ctx, target.Version, stage)
		if err != nil {
			return err
		}
		names := binaries()
		if err = extract(file, stage, names); err != nil {
			return err
		}
		built, err := inspect(ctx, filepath.Join(stage, names[0]))
		if err != nil {
			return err
		}
		if built != target {
			return errors.New("verified release binary disagrees with the release metadata")
		}
		if err = service.ReplacePrograms(stage, filepath.Dir(exe), names); err != nil {
			return err
		}
	} else if err = managerUpdate(ctx, method, exe, target.Version, out); err != nil {
		return err
	}
	disk, err = inspect(ctx, exe)
	if err != nil {
		return err
	}
	if disk != target {
		return fmt.Errorf("installed build differs from the approved release %s; check the package manager and upgrade manually", target.Version)
	}
	if !before.Held {
		// A stopped host can start while the download is in progress.
		before, err = active(root, exe)
		if err != nil {
			return err
		}
	}
	if before.Held {
		return activate(ctx, root, exe, target, before, out)
	}
	fmt.Fprintf(out, "Installed host %s; the host is stopped.\n", target.Version)
	return nil
}

// Keep the lock with the installation across accounts, cache directories and
// version changes. Managed version directories themselves are replaced on upgrade.
func installationLock(exe, method string) *flock.Flock {
	dir := filepath.Dir(exe)
	switch method {
	case "brew": // <prefix>/opt/n2n-nexus-host/bin/<exe>
		dir = filepath.Dir(filepath.Dir(dir))
	case "scoop": // <apps>/n2n-nexus-host/current/<exe>
		dir = filepath.Dir(dir)
	}
	return flock.New(filepath.Join(dir, ".n2n-nexus-host-update.lock"))
}

func inspect(ctx context.Context, exe string) (Build, error) {
	var result Build
	cmd := exec.CommandContext(ctx, exe, "auto-update", "info")
	b, err := cmd.Output()
	if err != nil {
		return result, fmt.Errorf("read build information from %s: %w", exe, err)
	}
	err = json.Unmarshal(b, &result)
	return result, err
}
func active(root, exe string) (host.LockInfo, error) {
	info, err := host.ReadLock(root)
	if err != nil || !info.Held {
		return info, err
	}
	if info.Executable == "" || !program.Same(info.Executable, exe) {
		return info, fmt.Errorf("the host running for %s does not identify this installation; restart it with %s", root, exe)
	}
	if !healthy(info, info.Version) {
		return info, errors.New("the running host did not confirm its version at /health")
	}
	return info, nil
}
func healthy(info host.LockInfo, v string) bool {
	if info.Version != v || v == "" {
		return false
	}
	bind, port, err := net.SplitHostPort(info.Address)
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	actual, ok := service.Probe(service.HealthAddr(bind, n), time.Second)
	return ok && actual == v
}
func checkRunning(info host.LockInfo, target Build) error {
	if !info.Held {
		return nil
	}
	if !stableVersion.MatchString(info.Version) || compare(info.Version, target.Version) > 0 {
		return fmt.Errorf("running host %s cannot be updated to %s", info.Version, target.Version)
	}
	return (Build{Version: info.Version, Contract: info.Contract, Schema: info.Schema}).compatible(target)
}
func activate(ctx context.Context, root, exe string, target Build, before host.LockInfo, out io.Writer) error {
	if err := checkRunning(before, target); err != nil {
		return err
	}
	info, err := host.ReadLock(root)
	if err != nil {
		return err
	}
	if !info.Held {
		return errors.New("host stopped during update; restart it to verify the installed version")
	}
	if !program.Same(exe, info.Executable) {
		return errors.New("running installation changed during update")
	}
	if healthy(info, target.Version) {
		fmt.Fprintf(out, "Host %s is running.\n", target.Version)
		return nil
	}
	if err = checkRunning(info, target); err != nil {
		return err
	}
	switch info.Role {
	case host.RoleSupervised:
		err = host.RequestRestart(root)
	case host.RoleTray, host.RoleServe:
		err = os.WriteFile(filepath.Join(root, host.UpdateRestartFile), []byte("restart\n"), 0600)
	default:
		return fmt.Errorf("unknown host role %q", info.Role)
	}
	if err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-wait.Done():
			return fmt.Errorf("installed host %s, but the running host did not confirm that version at /health: %w", target.Version, wait.Err())
		case <-ticker.C:
			live, err := host.ReadLock(root)
			if err != nil {
				return err
			}
			if live.Held && program.Same(exe, live.Executable) && healthy(live, target.Version) {
				fmt.Fprintf(out, "Host %s is running.\n", target.Version)
				return nil
			}
		}
	}
}
