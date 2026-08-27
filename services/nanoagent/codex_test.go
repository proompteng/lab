package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type recordingWriteCloser struct {
	content []byte
}

func (writer *recordingWriteCloser) Write(content []byte) (int, error) {
	writer.content = append(writer.content, content...)
	return len(content), nil
}

func (writer *recordingWriteCloser) Close() error {
	return nil
}

func (writer *recordingWriteCloser) Len() int {
	return len(writer.content)
}

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

func TestCodexBlockedWriteDoesNotHoldSupervisorStateLock(t *testing.T) {
	reader, writer := io.Pipe()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	supervisor.stdin = writer
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.request(ctx, "account/read", json.RawMessage(`{}`), false)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked request error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked Codex write ignored request cancellation")
	}
	select {
	case <-supervisor.writePermit:
		supervisor.writePermit <- struct{}{}
	case <-time.After(time.Second):
		t.Fatal("canceled Codex write retained the process write permit")
	}

	closed := make(chan struct{})
	go func() {
		supervisor.close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("blocked Codex write prevented supervisor shutdown")
	}
}

func TestCodexFailedStartupReturnsFailureToCurrentGenerationWaiters(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	waitingOn := supervisor.generation
	failure := errors.New("initialization failed")

	supervisor.failProcess(failure)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := supervisor.waitForGeneration(ctx, waitingOn); !errors.Is(err, failure) {
		t.Fatalf("failed generation waiter error = %v, want initialization failure", err)
	}
	if supervisor.generation == waitingOn {
		t.Fatal("failed process generation was not replaced")
	}
	select {
	case <-supervisor.generation.ready:
		t.Fatal("replacement process generation was released before initialization")
	default:
	}
	if supervisor.isReady() {
		t.Fatal("replacement process generation was reported ready before initialization")
	}
}

func TestApprovalResolutionRejectsUnknownApproval(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	if err := supervisor.resolveApproval(context.Background(), "missing", "approveOnce"); err == nil {
		t.Fatal("resolveApproval() accepted an unknown request")
	}
}

func TestApprovalResponseCannotCrossProcessGenerations(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	failedGeneration := supervisor.generation
	approval := codexApproval{
		generation: failedGeneration,
		method:     "applyPatchApproval",
		decisions:  defaultCodexApprovalDecisions(),
		rawID:      json.RawMessage(`7`),
		resolving:  true,
	}
	supervisor.approvals["7"] = approval

	supervisor.failProcess(errors.New("process exited"))
	replacement := &recordingWriteCloser{}
	supervisor.mu.Lock()
	supervisor.stdin = replacement
	supervisor.approvals["7"] = codexApproval{
		generation: supervisor.generation,
		method:     "item/fileChange/requestApproval",
		resolving:  true,
	}
	supervisor.mu.Unlock()

	result, err := codexApprovalResult(approval, "approveOnce")
	if err != nil {
		t.Fatalf("approval result: %v", err)
	}
	if err := supervisor.respondRawForGeneration(context.Background(), failedGeneration, approval.rawID, result); err == nil {
		t.Fatal("failed generation approval was written to the replacement process")
	}
	if replacement.Len() != 0 {
		t.Fatalf("replacement process received %d approval response bytes", replacement.Len())
	}

	supervisor.resetApproval("7", approval)
	supervisor.finishApproval("7", approval)
	supervisor.mu.Lock()
	current := supervisor.approvals["7"]
	supervisor.mu.Unlock()
	if current.generation != supervisor.generation || current.method != "item/fileChange/requestApproval" {
		t.Fatalf("old approval mutated replacement request: %#v", current)
	}
}

func TestCodexMessageReaderContinuesAfterOversizedLine(t *testing.T) {
	t.Parallel()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	valid := `{"method":"item/agentMessage/delta","params":{"delta":"ok"}}`
	input := strings.Repeat("x", 257) + "\n" + valid + "\n"

	supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(input), 256)

	if len(supervisor.buffer) != 2 {
		t.Fatalf("Codex event count = %d, want oversized warning and following event", len(supervisor.buffer))
	}
	if supervisor.buffer[0].Method != "tengri/eventOmitted" {
		t.Fatalf("oversized protocol event = %q", supervisor.buffer[0].Method)
	}
	if supervisor.buffer[1].Method != "item/agentMessage/delta" {
		t.Fatalf("event after oversized line = %q", supervisor.buffer[1].Method)
	}
}

func TestApprovalCancellationRestartsBlockedProcessWriter(t *testing.T) {
	t.Parallel()
	reader, writer := io.Pipe()
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	supervisor.stdin = writer
	supervisor.approvals["9"] = codexApproval{
		generation: supervisor.generation,
		method:     "applyPatchApproval",
		decisions:  defaultCodexApprovalDecisions(),
		rawID:      json.RawMessage(`9`),
	}
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := supervisor.resolveApproval(ctx, "9", "approveOnce")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked approval error = %v, want deadline exceeded", err)
	}
	select {
	case <-supervisor.writePermit:
		supervisor.writePermit <- struct{}{}
	case <-time.After(time.Second):
		t.Fatal("canceled approval retained the process write permit")
	}
}

func TestAutomaticCodexResponsesRestartBlockedProcessWriter(t *testing.T) {
	tests := []struct {
		name    string
		message codexRPCMessage
	}{
		{
			name:    "current time",
			message: codexRPCMessage{ID: json.RawMessage(`10`), Method: "currentTime/read"},
		},
		{
			name:    "unsupported request",
			message: codexRPCMessage{ID: json.RawMessage(`11`), Method: "unsupported/request"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reader, writer := io.Pipe()
			supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
			supervisor.stdin = writer
			supervisor.responseTimeout = 50 * time.Millisecond
			t.Cleanup(func() {
				_ = reader.Close()
				_ = writer.Close()
			})

			done := make(chan struct{})
			go func() {
				supervisor.handleServerMessage(supervisor.generation, test.message, nil)
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("automatic Codex response remained blocked after its write deadline")
			}
			select {
			case <-supervisor.writePermit:
				supervisor.writePermit <- struct{}{}
			case <-time.After(time.Second):
				t.Fatal("automatic Codex response retained the process write permit")
			}
		})
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

func TestCodexDeviceLoginRestartCancelsThePreviousAttempt(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a local fake app-server process")
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "cancel.json")
	binary := filepath.Join(directory, "fake-codex")
	script := fmt.Sprintf(`#!/bin/sh
IFS= read -r initialize
id=$(printf '%%s\n' "$initialize" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%%s,"result":{}}\n' "$id"
IFS= read -r initialized
IFS= read -r first_login
id=$(printf '%%s\n' "$first_login" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%%s,"result":{"type":"chatgptDeviceCode","loginId":"login-one","verificationUrl":"https://example.test/one","userCode":"ONE"}}\n' "$id"
IFS= read -r cancel_login
printf '%%s' "$cancel_login" > %q
id=$(printf '%%s\n' "$cancel_login" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%%s,"result":{}}\n' "$id"
IFS= read -r second_login
id=$(printf '%%s\n' "$second_login" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%%s,"result":{"type":"chatgptDeviceCode","loginId":"login-two","verificationUrl":"https://example.test/two","userCode":"TWO"}}\n' "$id"
sleep 30
`, marker)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake app-server: %v", err)
	}

	supervisor := newCodexSupervisor(binary, directory)
	supervisor.start()
	t.Cleanup(supervisor.close)
	deadline := time.Now().Add(3 * time.Second)
	for !supervisor.isReady() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !supervisor.isReady() {
		t.Fatal("Codex supervisor did not become ready")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	params := json.RawMessage(`{"type":"chatgptDeviceCode"}`)
	if _, err := supervisor.call(ctx, "account/login/start", params); err != nil {
		t.Fatalf("start first device login: %v", err)
	}
	result, err := supervisor.call(ctx, "account/login/start", params)
	if err != nil {
		t.Fatalf("restart device login: %v", err)
	}
	if !strings.Contains(string(result), `"loginId":"login-two"`) {
		t.Fatalf("restarted login result = %s", result)
	}
	cancelRequest, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read cancellation request: %v", err)
	}
	var request struct {
		Method string `json:"method"`
		Params struct {
			LoginID string `json:"loginId"`
		} `json:"params"`
	}
	if json.Unmarshal(cancelRequest, &request) != nil || request.Method != "account/login/cancel" ||
		request.Params.LoginID != "login-one" {
		t.Fatalf("device login cancellation = %s", cancelRequest)
	}
}

func TestCodexDeviceLoginRestartRetainsPreviousAttemptWhenCancellationFails(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a local fake app-server process")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "fake-codex")
	script := `#!/bin/sh
IFS= read -r initialize
id=$(printf '%s\n' "$initialize" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%s,"result":{}}\n' "$id"
IFS= read -r initialized
IFS= read -r first_login
id=$(printf '%s\n' "$first_login" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%s,"result":{"type":"chatgptDeviceCode","loginId":"login-one","verificationUrl":"https://example.test/one","userCode":"ONE"}}\n' "$id"
IFS= read -r cancel_login
id=$(printf '%s\n' "$cancel_login" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{"id":%s,"error":{"code":-32000,"message":"cannot cancel"}}\n' "$id"
sleep 30
`
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake app-server: %v", err)
	}

	supervisor := newCodexSupervisor(binary, directory)
	supervisor.start()
	t.Cleanup(supervisor.close)
	deadline := time.Now().Add(3 * time.Second)
	for !supervisor.isReady() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !supervisor.isReady() {
		t.Fatal("Codex supervisor did not become ready")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	params := json.RawMessage(`{"type":"chatgptDeviceCode"}`)
	if _, err := supervisor.call(ctx, "account/login/start", params); err != nil {
		t.Fatalf("start first device login: %v", err)
	}
	if _, err := supervisor.call(ctx, "account/login/start", params); err == nil ||
		!strings.Contains(err.Error(), "cancel previous Codex device login") {
		t.Fatalf("restart device login error = %v", err)
	}

	supervisor.mu.Lock()
	activeLoginID := supervisor.activeLoginID
	supervisor.mu.Unlock()
	if activeLoginID != "login-one" {
		t.Fatalf("active login ID = %q, want login-one", activeLoginID)
	}
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

func TestCommandApprovalHonorsAvailableDecisions(t *testing.T) {
	t.Parallel()
	decisions := codexApprovalDecisions(
		"item/commandExecution/requestApproval",
		json.RawMessage(`{"availableDecisions":["accept","decline"]}`),
	)
	approval := codexApproval{method: "item/commandExecution/requestApproval", decisions: decisions}
	if _, err := codexApprovalResult(approval, "approveSession"); err == nil {
		t.Fatal("session approval was accepted when app-server did not offer it")
	}
	once, err := codexApprovalResult(approval, "approveOnce")
	if err != nil || once["decision"] != "accept" {
		t.Fatalf("approve once = %#v, %v", once, err)
	}
	denied, err := codexApprovalResult(approval, "deny")
	if err != nil || denied["decision"] != "decline" {
		t.Fatalf("deny = %#v, %v", denied, err)
	}

	cancelOnly := codexApproval{
		method:    "item/commandExecution/requestApproval",
		decisions: map[string]json.RawMessage{"deny": encodedCodexDecision("cancel")},
	}
	cancelled, err := codexApprovalResult(cancelOnly, "deny")
	if err != nil || cancelled["decision"] != "cancel" {
		t.Fatalf("cancel denial = %#v, %v", cancelled, err)
	}

	structured := codexApprovalDecisions(
		"item/commandExecution/requestApproval",
		json.RawMessage(`{"availableDecisions":[{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git status"]}},{"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"github.com","action":"allow"}}},"decline"]}`),
	)
	structuredApproval := codexApproval{method: "item/commandExecution/requestApproval", decisions: structured}
	execPolicy, err := codexApprovalResult(structuredApproval, "approveExecPolicyAmendment")
	if err != nil {
		t.Fatalf("exec-policy amendment: %v", err)
	}
	execDecision := execPolicy["decision"].(map[string]any)
	if _, found := execDecision["acceptWithExecpolicyAmendment"]; !found {
		t.Fatalf("exec-policy decision = %#v", execDecision)
	}
	networkPolicy, err := codexApprovalResult(structuredApproval, "approveNetworkPolicyAmendment")
	if err != nil {
		t.Fatalf("network-policy amendment: %v", err)
	}
	networkDecision := networkPolicy["decision"].(map[string]any)
	if _, found := networkDecision["applyNetworkPolicyAmendment"]; !found {
		t.Fatalf("network-policy decision = %#v", networkDecision)
	}
}
