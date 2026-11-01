//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestCodexProcessConfirmsDetachedChildrenStopBeforeRecovery(t *testing.T) {
	for _, ending := range []string{"native exit", "supervisor stop", "supervisor parent exit"} {
		t.Run(ending, func(t *testing.T) {
			workspace := t.TempDir()
			marker, gate := filepath.Join(workspace, "children"), filepath.Join(workspace, "exit")
			binary := filepath.Join(workspace, "codex-fixture")
			script := fmt.Sprintf(`#!/bin/sh
setsid env -i PATH="$PATH" sh -c 'sleep 60 & printf "%%s %%s" "$$" "$!" > "$1"; wait' child %q &
while [ ! -f %q ]; do sleep 0.01; done
exit 1
`, marker, gate)
			if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			unrelated := exec.Command("sleep", "60")
			if err := unrelated.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = unrelated.Process.Kill(); _ = unrelated.Wait() })
			generation := strings.Repeat("a", 32)
			command, err := codexProcessCommand(binary, nil, workspace, generation)
			if err != nil {
				t.Fatal(err)
			}
			if ending == "supervisor parent exit" {
				self, _ := os.Executable()
				command = exec.Command("sh", "-c", `"$1" codex-process "$2" "$3" "$$" "$4" & wait`, "parent", self, generation, workspace, binary)
			}
			var output bytes.Buffer
			command.Stderr = &output
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = command.Process.Kill() })
			deadline := time.Now().Add(5 * time.Second)
			var pids []string
			for {
				content, _ := os.ReadFile(marker)
				pids = strings.Fields(string(content))
				if len(pids) == 2 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("detached child fixture did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			var children []*os.File
			for _, value := range pids {
				pid, _ := strconv.Atoi(value)
				child, err := pinProcessIdentity(pid)
				if err != nil {
					t.Fatal(err)
				}
				children = append(children, child)
				t.Cleanup(func() { _ = child.Close() })
			}
			supervisor := newCodexSupervisor("unused", workspace)
			if supervisor.generationProcessesStopped(generation) {
				t.Fatal("a live generation published a cleanup receipt")
			}
			switch ending {
			case "native exit":
				if err := os.WriteFile(gate, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "supervisor stop":
				stopCodexProcess(command)
			case "supervisor parent exit":
				_ = command.Process.Kill()
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			for !supervisor.generationProcessesStopped(generation) {
				if time.Now().After(deadline) {
					t.Fatal("generation cleanup was not confirmed")
				}
				time.Sleep(10 * time.Millisecond)
			}
			for _, child := range children {
				poll := []unix.PollFd{{Fd: int32(child.Fd()), Events: unix.POLLIN}}
				if _, err := unix.Poll(poll, 0); err != nil || poll[0].Revents&unix.POLLIN == 0 {
					t.Fatalf("cleanup receipt preceded detached child exit: %#v %v", poll, err)
				}
			}
			if err := unrelated.Process.Signal(unix.Signal(0)); err != nil {
				t.Fatalf("generation cleanup stopped an unrelated process: %v", err)
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("generation supervisor did not exit")
			}
		})
	}
}

func TestCodexGenerationRecoveryRequiresAValidatedBootOrCleanupReceipt(t *testing.T) {
	workspace, generation := t.TempDir(), strings.Repeat("b", 32)
	supervisor := newCodexSupervisor("unused", workspace)
	boot, err := os.ReadFile(bootIDPath)
	if err != nil {
		t.Fatal(err)
	}
	current := strings.TrimSpace(string(boot))
	for _, test := range []struct {
		receipt codexGenerationReceipt
		stopped bool
	}{
		{codexGenerationReceipt{1, generation, current, false}, false},
		{codexGenerationReceipt{1, generation, current, true}, true},
		{codexGenerationReceipt{1, generation, "11111111-1111-4111-8111-111111111111", false}, true},
		{codexGenerationReceipt{1, strings.Repeat("c", 32), current, true}, false},
		{codexGenerationReceipt{2, generation, current, true}, false},
		{codexGenerationReceipt{1, generation, "", true}, false},
	} {
		path := codexGenerationPath(workspace, generation)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		content, _ := json.Marshal(test.receipt)
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if got := supervisor.generationProcessesStopped(generation); got != test.stopped {
			t.Fatalf("receipt %+v recovered=%v, want %v", test.receipt, got, test.stopped)
		}
	}
}
