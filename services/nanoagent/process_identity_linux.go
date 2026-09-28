//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func pinProcessIdentity(processID int) (*os.File, error) {
	descriptor, err := unix.PidfdOpen(processID, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), fmt.Sprintf("pidfd:%d", processID))
	if file == nil {
		_ = unix.Close(descriptor)
		return nil, fmt.Errorf("wrap pidfd for process %d", processID)
	}
	return file, nil
}

func waitForPinnedProcessExit(process *os.File) error {
	if process == nil {
		return errors.New("process identity is unavailable")
	}
	for {
		descriptors := []unix.PollFd{{Fd: int32(process.Fd()), Events: unix.POLLIN}}
		_, err := unix.Poll(descriptors, -1)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		events := descriptors[0].Revents
		if events&(unix.POLLIN|unix.POLLHUP) != 0 {
			return nil
		}
		if events&(unix.POLLERR|unix.POLLNVAL) != 0 {
			return fmt.Errorf("poll pidfd: events %#x", events)
		}
	}
}

func signalPinnedProcessIdentity(procRoot string, identity processIdentity, signal syscall.Signal) error {
	process, err := pinProcessIdentity(identity.processID)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("pin process %d before signaling: %w", identity.processID, err)
	}
	defer process.Close()

	current, err := readProcessIdentity(procRoot, identity.processID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("validate pinned process %d: %w", identity.processID, err)
	}
	if current.sessionID != identity.sessionID || current.startTime != identity.startTime {
		return nil
	}
	if err := unix.PidfdSendSignal(int(process.Fd()), unix.Signal(signal), nil, 0); err != nil &&
		!errors.Is(err, unix.ESRCH) {
		return fmt.Errorf("signal pinned process %d: %w", identity.processID, err)
	}
	return nil
}
