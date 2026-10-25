//go:build !linux

package main

import (
	"errors"
	"os"
	"syscall"
)

func pinProcessIdentity(_ int) (*os.File, error) {
	// Nanoagent production guests are Linux. Keep local non-Linux development functional while the random marker,
	// leader start time, and surviving-process snapshots retain the conservative cleanup fallback.
	return nil, nil
}

func waitForPinnedProcessExit(_ *os.File) error {
	return errors.New("pidfd process waiting is unavailable")
}

func signalPinnedProcessIdentity(procRoot string, identity processIdentity, signal syscall.Signal) error {
	return signalProcessIdentity(procRoot, identity, signal, syscall.Kill)
}
