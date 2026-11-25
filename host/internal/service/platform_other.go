//go:build !windows && !darwin && !linux

package service

import (
	"errors"
	"io"
	"runtime"
)

var errUnsupported = errors.New("service install is not supported on " + runtime.GOOS)

func checkTarget(target) error            { return errUnsupported }
func stopService(target, io.Writer) error { return errUnsupported }
func register(target, io.Writer) error    { return errUnsupported }
func unregister(target, io.Writer) error  { return errUnsupported }
func serviceState(target) string          { return errUnsupported.Error() }
func portOwner(int) string                { return "" }

func registeredServe() ([]string, error) { return nil, errUnsupported }
