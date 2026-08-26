package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexRPCAllowlistExposesOnlyDesktopOperations(t *testing.T) {
	t.Parallel()
	allowed := []string{
		"account/read",
		"account/login/start",
		"thread/start",
		"thread/resume",
		"turn/start",
		"turn/steer",
		"turn/interrupt",
	}
	for _, method := range allowed {
		if !allowedCodexMethod(method) {
			t.Fatalf("expected %q to be allowed", method)
		}
	}
	for _, method := range []string{"config/write", "shell/exec", "mcpServer/add", ""} {
		if allowedCodexMethod(method) {
			t.Fatalf("expected %q to be rejected", method)
		}
	}
}

func TestApprovalResolutionRejectsUnknownApproval(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	if err := supervisor.resolveApproval("missing", "approveOnce"); err == nil {
		t.Fatal("resolveApproval() accepted an unknown request")
	}
}

func TestCodexSupervisorCompletesInitializationHandshake(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a local fake app-server process")
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "initialized.json")
	binary := filepath.Join(directory, "fake-codex")
	script := fmt.Sprintf(`#!/bin/sh
IFS= read -r initialize
printf '%%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
printf '%%s' "$initialized" > %q
sleep 30
`, marker)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake app-server: %v", err)
	}

	supervisor := newCodexSupervisor(binary, directory)
	supervisor.start()
	t.Cleanup(supervisor.close)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(marker)
		if err == nil {
			var notification struct {
				Method string `json:"method"`
			}
			if json.Unmarshal(content, &notification) != nil || notification.Method != "initialized" {
				t.Fatalf("initialization notification = %q", strings.TrimSpace(string(content)))
			}
			if !supervisor.isReady() {
				t.Fatal("Codex supervisor was not ready after the initialization handshake")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Codex app-server did not receive the initialized notification")
}

func TestCodexSupervisorRestartsAfterProcessExit(t *testing.T) {
	if testing.Short() {
		t.Skip("starts local fake app-server processes")
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "starts")
	binary := filepath.Join(directory, "fake-codex")
	script := fmt.Sprintf(`#!/bin/sh
IFS= read -r initialize
id=$(printf '%%s\n' "$initialize" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%%s,"result":{}}\n' "$id"
IFS= read -r initialized
printf 'started\n' >> %q
exit 17
`, marker)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake app-server: %v", err)
	}

	supervisor := newCodexSupervisor(binary, directory)
	supervisor.start()
	t.Cleanup(supervisor.close)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(marker)
		if err == nil && strings.Count(string(content), "started\n") >= 2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	content, _ := os.ReadFile(marker)
	t.Fatalf("Codex app-server starts = %d, want at least 2", strings.Count(string(content), "started\n"))
}

func TestCodexReplayDoesNotBlockWhenBufferExceedsSubscriberBurst(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	for index := 0; index < 1_000; index++ {
		supervisor.publish("item/agentMessage/delta", "", map[string]any{"params": map[string]string{"delta": "x"}})
	}
	id, events, err := supervisor.subscribe(0)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer supervisor.unsubscribe(id)
	for expected := uint64(1); expected <= 1_000; expected++ {
		select {
		case event := <-events:
			if event.Sequence != expected {
				t.Fatalf("replayed sequence = %d, want %d", event.Sequence, expected)
			}
		default:
			t.Fatalf("replay stopped before sequence %d", expected)
		}
	}
}

func TestCodexReplaySignalsExpiredCursorAndDisconnectsSlowSubscriber(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	for index := 0; index < codexEventBufferSize+10; index++ {
		supervisor.publish("item/agentMessage/delta", "", map[string]any{"params": map[string]string{"delta": "x"}})
	}
	id, events, err := supervisor.subscribe(1)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	warning := <-events
	if warning.Method != "tengri/replayWarning" || warning.Sequence != supervisor.buffer[0].Sequence-1 {
		t.Fatalf("replay warning = %#v", warning)
	}
	supervisor.unsubscribe(id)

	id, events, err = supervisor.subscribe(supervisor.sequence)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	for index := 0; index < 257; index++ {
		supervisor.publish("item/agentMessage/delta", "", map[string]any{"params": map[string]string{"delta": "x"}})
	}
	if _, found := supervisor.subscriptions[id]; found {
		t.Fatal("slow Codex subscriber remained registered after its bounded queue filled")
	}
	for range events {
	}
}

func TestCodexReplaySignalsCursorFromPreviousProcess(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	id, events, err := supervisor.subscribe(42)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer supervisor.unsubscribe(id)

	warning := <-events
	if warning.Method != "tengri/replayWarning" || warning.Sequence != 0 {
		t.Fatalf("replay warning = %#v", warning)
	}
}

func TestCodexReplayIsBoundedByBytesAndSubscribers(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	payload := strings.Repeat("x", codexEventMaxBytes/2)
	for range 40 {
		supervisor.publish("item/agentMessage/delta", "", map[string]string{"delta": payload})
	}
	if supervisor.bufferBytes > codexEventBufferBytes {
		t.Fatalf("buffer bytes = %d, want at most %d", supervisor.bufferBytes, codexEventBufferBytes)
	}

	ids := make([]uint64, 0, codexSubscriberLimit)
	for range codexSubscriberLimit {
		id, _, err := supervisor.subscribe(supervisor.sequence)
		if err != nil {
			t.Fatalf("subscribe within limit: %v", err)
		}
		ids = append(ids, id)
	}
	if _, _, err := supervisor.subscribe(supervisor.sequence); err == nil {
		t.Fatal("subscriber limit was not enforced")
	}
	for _, id := range ids {
		supervisor.unsubscribe(id)
	}
}

func TestCodexOversizedEventIsReplacedWithTruthfulWarning(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	supervisor.publish("item/tool/output", "approval", json.RawMessage(`{"value":"`+strings.Repeat("x", codexEventMaxBytes)+`"}`))
	if len(supervisor.buffer) != 1 || supervisor.buffer[0].Method != "tengri/eventOmitted" {
		t.Fatalf("oversized event = %#v", supervisor.buffer)
	}
	if !strings.Contains(string(supervisor.buffer[0].Raw), "item/tool/output") {
		t.Fatalf("warning does not identify omitted method: %s", supervisor.buffer[0].Raw)
	}
	if supervisor.buffer[0].ApprovalID != "approval" {
		t.Fatalf("oversized approval ID = %q, want preserved approval", supervisor.buffer[0].ApprovalID)
	}
}

func TestPermissionApprovalReturnsOnlyRequestedPermissions(t *testing.T) {
	t.Parallel()
	requested := json.RawMessage(`{"fileSystem":{"write":["/workspace"]}}`)
	approval := codexApproval{method: "item/permissions/requestApproval", permissions: requested}

	once, err := codexApprovalResult(approval, "approveOnce")
	if err != nil {
		t.Fatalf("approve once: %v", err)
	}
	if once["scope"] != "turn" || string(once["permissions"].(json.RawMessage)) != string(requested) {
		t.Fatalf("unexpected turn grant: %#v", once)
	}

	session, err := codexApprovalResult(approval, "approveSession")
	if err != nil {
		t.Fatalf("approve session: %v", err)
	}
	if session["scope"] != "session" || string(session["permissions"].(json.RawMessage)) != string(requested) {
		t.Fatalf("unexpected session grant: %#v", session)
	}

	denied, err := codexApprovalResult(approval, "deny")
	if err != nil {
		t.Fatalf("deny: %v", err)
	}
	if denied["scope"] != "turn" || string(denied["permissions"].(json.RawMessage)) != `{}` {
		t.Fatalf("unexpected denied grant: %#v", denied)
	}
}
