//go:build linux

package main

import (
	"fmt"

	"golang.org/x/sys/unix"
)

func hardenProcessMemory() error {
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("disable Nanoagent process dumpability: %w", err)
	}
	return nil
}
