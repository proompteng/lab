//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestTerminalManagerCleansEnvironmentSanitizedDescendantAfterLeaderExit(t *testing.T) {
	envPath, err := exec.LookPath("env")
	if err != nil {
		t.Fatalf("locate env: %v", err)
	}
	sleepPath, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatalf("locate sleep: %v", err)
	}

	root := t.TempDir()
	shell := filepath.Join(root, "sanitized-descendant.sh")
	script := fmt.Sprintf("#!/bin/sh\n%q -i %q 30 </dev/null >/dev/null 2>&1 &\nexit 0\n", envPath, sleepPath)
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatalf("write terminal fixture: %v", err)
	}
	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, shell, workspace.root)
	manager.cleanupDelay = 20 * time.Millisecond
	t.Cleanup(manager.close)

	view, _, err := manager.create("terminal-creation-sanitized-descendant", "/", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}
	select {
	case <-session.processExited:
	case <-time.After(3 * time.Second):
		t.Fatal("terminal leader did not exit")
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		processes, err := processIDsInSession("/proc", session.processSessionID)
		if err != nil {
			t.Fatalf("scan terminal process session: %v", err)
		}
		if len(processes) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal process session still contains processes %v", processes)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
