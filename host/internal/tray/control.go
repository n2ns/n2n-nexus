package tray

import (
	"log"
	"os/exec"
	"runtime"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/discovery"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// Options configure the tray.
type Options struct {
	Version                string
	DataDir                string
	LogDir                 string
	Exe                    string
	ServiceUpdateRequested func(*log.Logger)
}

// isLAN reports whether settings make the host reachable from the LAN.
func isLAN(s config.Settings) bool { return discovery.AnswersDiscovery(s.Host) }

// setLAN writes host 0.0.0.0 (on) or 127.0.0.1 (off) to settings.json, keeping the other fields.
func setLAN(dataDir string, on bool) (config.Settings, error) {
	s, err := config.LoadSettings(dataDir)
	if err != nil {
		return s, err
	}
	s.Host = "127.0.0.1"
	if on {
		s.Host = "0.0.0.0"
	}
	return s, config.SaveSettings(dataDir, s)
}

// probeAddrs are the addresses to look for a running host on: loopback, and
// the configured host when it is a specific address.
func probeAddrs(s config.Settings) []string {
	addrs := []string{service.HealthAddr("127.0.0.1", s.Port)}
	if a := service.HealthAddr(s.Host, s.Port); a != addrs[0] && s.Host != "localhost" {
		addrs = append(addrs, a)
	}
	return addrs
}

// findRunning returns the address of a host already answering, or "".
func findRunning(s config.Settings) string {
	if s.Port == 0 {
		return ""
	}
	for _, a := range probeAddrs(s) {
		if _, ok := service.Probe(a, time.Second); ok {
			return a
		}
	}
	return ""
}

// openFolder shows dir in the platform's file manager.
func openFolder(dir string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
