package host

import (
	"os"
	"path/filepath"
	"time"
)

// RestartRequestFile in the data directory asks a supervised serve to exit, so
// that its supervisor starts it again with the current settings. A file works
// across logon sessions: the tray cannot end a service process that runs under
// the scheduled task's S4U logon (OpenProcess is denied), but it can write here.
const RestartRequestFile = "restart-request"

// RequestRestart asks the supervised serve for dataDir to restart.
func RequestRestart(dataDir string) error {
	return os.WriteFile(filepath.Join(dataDir, RestartRequestFile), []byte("restart\n"), 0o600)
}

// WatchRestart polls for a restart request every interval until done closes;
// it removes the request and calls onRequest once. since is when this serve
// began starting (before it took the lock): an older request was served by an
// earlier serve and is removed, a newer one (written while this serve started,
// with settings it may not have loaded) restarts it.
func WatchRestart(dataDir string, since time.Time, interval time.Duration, done <-chan struct{}, onRequest func()) {
	path := filepath.Join(dataDir, RestartRequestFile)
	if info, err := os.Stat(path); err == nil && info.ModTime().Before(since) {
		_ = os.Remove(path)
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if _, err := os.Stat(path); err != nil {
					continue
				}
				_ = os.Remove(path)
				onRequest()
				return
			}
		}
	}()
}
