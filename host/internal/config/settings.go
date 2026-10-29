package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Settings are the daemon settings in <data dir>/settings.json.
type Settings struct {
	Host          string   `json:"host"`
	Port          int      `json:"port"`
	DiscoveryPort int      `json:"discoveryPort"`
	AllowedHosts  []string `json:"allowedHosts"`
	// RateLimit is tool calls per second per instance (0 disables); RateBurst the bucket size.
	RateLimit    float64 `json:"rateLimit"`
	RateBurst    float64 `json:"rateBurst"`
	MaxAutoTurns int     `json:"maxAutoTurns"`
	// StanceReminderMinutes: a meeting quiet this long reminds the approvers of
	// its current draft that took no stance (0 disables the reminders).
	StanceReminderMinutes int `json:"stanceReminderMinutes"`
	// MeetingRetentionDays: a meeting closed or archived this long ago is
	// deleted, and an active meeting without a message for this long is
	// closed as expired.
	MeetingRetentionDays int `json:"meetingRetentionDays"`
	// RetentionDays: read or expired direct messages, delivered notices,
	// events, finished tasks, sessions offline and adapter instances not seen
	// this long are deleted.
	RetentionDays int `json:"retentionDays"`
}

// Override applies the --host and --port flags: host when not empty, port
// when not negative.
func (s *Settings) Override(host string, port int) {
	if host != "" {
		s.Host = host
	}
	if port >= 0 {
		s.Port = port
	}
}

// Defaults are the settings of a fresh install.
func Defaults() Settings {
	return Settings{
		Host:                  "127.0.0.1",
		Port:                  5688,
		DiscoveryPort:         5688,
		AllowedHosts:          []string{},
		RateLimit:             20,
		RateBurst:             60,
		MaxAutoTurns:          0,
		StanceReminderMinutes: 10,
		MeetingRetentionDays:  30,
		RetentionDays:         7,
	}
}

// SettingsFile is settings.json in dataDir.
func SettingsFile(dataDir string) string { return filepath.Join(dataDir, "settings.json") }

// LoadSettings reads settings.json from dataDir; a missing file gives the defaults.
// Fields absent from the file keep their defaults.
func LoadSettings(dataDir string) (Settings, error) {
	s := Defaults()
	raw, err := os.ReadFile(SettingsFile(dataDir))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return s, fmt.Errorf("%s: %w", SettingsFile(dataDir), err)
	}
	return s, s.Validate()
}

// Validate rejects settings the daemon cannot run with.
func (s Settings) Validate() error {
	switch {
	case s.Host == "":
		return errors.New("settings: host is empty")
	case s.Port < 0 || s.Port > 65535:
		return fmt.Errorf("settings: port %d out of range", s.Port)
	case s.DiscoveryPort < 1 || s.DiscoveryPort > 65535:
		return fmt.Errorf("settings: discoveryPort %d out of range", s.DiscoveryPort)
	case s.RateLimit < 0 || s.RateBurst < 0:
		return errors.New("settings: rateLimit and rateBurst must not be negative")
	case s.MaxAutoTurns < 0:
		return errors.New("settings: maxAutoTurns must not be negative")
	case s.StanceReminderMinutes < 0:
		return errors.New("settings: stanceReminderMinutes must not be negative")
	case s.MeetingRetentionDays < 1:
		return errors.New("settings: meetingRetentionDays must be at least 1")
	case s.RetentionDays < 1:
		return errors.New("settings: retentionDays must be at least 1")
	}
	return nil
}

// SaveSettings writes settings.json atomically (temporary file, then rename).
func SaveSettings(dataDir string, s Settings) error {
	if err := s.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := SettingsFile(dataDir) + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, SettingsFile(dataDir))
}
