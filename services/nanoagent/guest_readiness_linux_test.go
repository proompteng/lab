//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestGuestReadinessTerminalRetainsItsPreparedShell(t *testing.T) {
	probe, err := startGuestReadinessTerminal(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(probe.close)
	pid := probe.command.Process.Pid
	for range 25 {
		if err := probe.check(); err != nil {
			t.Fatal(err)
		}
		if probe.command.Process.Pid != pid {
			t.Fatal("readiness replaced its prepared shell")
		}
	}
	if probe.sequence != 25 {
		t.Fatalf("readiness challenges = %d, want 25", probe.sequence)
	}
}

func TestGuestReadinessTerminalRejectsAnUnexpectedChallenge(t *testing.T) {
	probe, err := startGuestReadinessTerminal(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(probe.close)
	if _, err := probe.terminal.WriteString("unexpected\n"); err != nil {
		t.Fatal(err)
	}
	if err := probe.check(); err == nil || !strings.Contains(err.Error(), "unexpected challenge") {
		t.Fatalf("unexpected terminal output was accepted: %v", err)
	}
	if err := probe.check(); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("failed readiness shell was recreated: %v", err)
	}
}

func TestGuestReadinessTerminalFailsClosedWhenItsShellExits(t *testing.T) {
	probe, err := startGuestReadinessTerminal(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(probe.close)
	if err := probe.command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := probe.check(); err == nil {
		t.Fatal("exited readiness shell was accepted")
	}
	if !probe.closed || probe.command.ProcessState == nil || !errors.Is(probe.command.Process.Signal(syscall.Signal(0)), os.ErrProcessDone) {
		t.Fatal("failed readiness shell was not reaped")
	}
}

func TestGuestReadinessTerminalTimeoutStopsAndReapsItsShell(t *testing.T) {
	probe, err := startGuestReadinessTerminal(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(probe.close)
	if err := probe.check(); err != nil {
		t.Fatal(err)
	}
	if err := probe.command.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	if err := probe.check(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unresponsive readiness shell was accepted: %v", err)
	}
	if !probe.closed || probe.command.ProcessState == nil || !errors.Is(probe.command.Process.Signal(syscall.Signal(0)), os.ErrProcessDone) {
		t.Fatal("timed-out readiness shell was not reaped")
	}
}
