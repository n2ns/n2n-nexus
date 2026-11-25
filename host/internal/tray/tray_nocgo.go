//go:build darwin && !cgo

// Package tray is the default mode of n2n-nexus-host. On macOS the tray needs
// Cocoa through cgo: this build (CGO_ENABLED=0) has only serve, service and autostart.
package tray

import (
	"errors"
	"log"
)

// Run reports that this build has no tray.
func Run(Options, func(*log.Logger) func()) error {
	return errors.New("this build has no tray: build with CGO_ENABLED=1 on macOS, or run `n2n-nexus-host serve`")
}
