package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const operationParams = `{"threadId":"thread-1","clientUserMessageId":"11111111-1111-4111-8111-111111111111","input":[{"type":"text","text":"Create the requested file"}]}`

func TestCodexDispatchDoesNotResumeForOtherRejections(t *testing.T) {
	for _, test := range []struct {
		method  string
		code    int
		message string
	}{
		{"turn/start", -32600, "thread not found: another-thread"},
		{"turn/start", -32600, "invalid request"},
		{"turn/start", -32602, "thread not found: thread-1"},
		{"turn/steer", -32600, "thread not found: thread-1"},
	} {
		t.Run(test.method+test.message+fmt.Sprint(test.code), func(t *testing.T) {
			supervisor, writer := readyCodexSupervisor(t)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := supervisor.dispatchOperation(ctx, test.method, json.RawMessage(operationParams), supervisor.generation, nil)
				done <- err
			}()
			request := readCodexWireRequest(t, writer)
			response, _ := json.Marshal(map[string]any{"id": request.ID, "error": map[string]any{"code": test.code, "message": test.message}})
			supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(string(response)+"\n"), codexProtocolLineMaxBytes)
			var rpcError *codexRPCError
			if err := <-done; !errors.As(err, &rpcError) || rpcError.code != test.code || rpcError.message != test.message {
				t.Fatalf("unrelated native rejection changed: %v", err)
			}
			select {
			case request := <-writer.messages:
				t.Fatalf("rejection dispatched another request: %s", request)
			default:
			}
		})
	}
}

func acceptOperation(t *testing.T, supervisor *codexSupervisor, writer *codexWireWriter) codexCallResult {
	t.Helper()
	type reply struct {
		result codexCallResult
		err    error
	}
	done := make(chan reply, 1)
	go func() {
		result, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
		done <- reply{result, err}
	}()
	request := readCodexWireRequest(t, writer)
	response, err := json.Marshal(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"turn-1","status":"inProgress"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(string(response)+"\n"), codexProtocolLineMaxBytes)
	select {
	case reply := <-done:
		if reply.err != nil {
			t.Fatal(reply.err)
		}
		return reply.result
	case <-time.After(time.Second):
		t.Fatal("accepted operation did not return")
		return codexCallResult{}
	}
}

func TestCodexOperationRetryReturnsCommittedTurnWithoutDispatch(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	accepted := acceptOperation(t, supervisor, writer)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	repeated, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams))
	if err != nil || string(repeated.result) != string(accepted.result) {
		t.Fatalf("retry must return the committed turn, result=%s error=%v", repeated.result, err)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("retry dispatched another request: %s", request)
	default:
	}
}

func TestCodexReconciliationReleasesOnlyAnOperationFencedByAColdBoot(t *testing.T) {
	const originalBoot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const replacementBoot = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	const reconcile = `{"operationId":"11111111-1111-4111-8111-111111111111","threadId":"thread-1"}`
	unsupportedHistory := json.RawMessage(`{"code":-32601,"message":"thread/items/list is not supported yet"}`)
	for _, test := range []struct {
		name, boot, currentBoot string
		retainedBoot            bool
		historyError            json.RawMessage
		resumeError             json.RawMessage
		retainedHistory         json.RawMessage
		wantReleased            bool
	}{
		{name: "record predates boot evidence", currentBoot: replacementBoot},
		{name: "same boot", boot: originalBoot, currentBoot: originalBoot, retainedBoot: true},
		{name: "different boot", boot: originalBoot, currentBoot: replacementBoot, wantReleased: true},
		{name: "legacy operation with fenced retained root", currentBoot: replacementBoot, retainedBoot: true, wantReleased: true},
		{
			name: "legacy operation with no native rollout", currentBoot: replacementBoot, retainedBoot: true, wantReleased: true,
			historyError: json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-1"}`),
		},
		{
			name: "history methods unavailable for missing rollout", currentBoot: replacementBoot, retainedBoot: true, wantReleased: true,
			historyError: unsupportedHistory,
			resumeError:  json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-1"}`),
		},
		{
			name: "missing rollout error for another thread", currentBoot: replacementBoot, retainedBoot: true,
			historyError: unsupportedHistory,
			resumeError:  json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id another-thread"}`),
		},
		{
			name: "rollout lookup unavailable", currentBoot: replacementBoot, retainedBoot: true,
			historyError: unsupportedHistory,
			resumeError:  json.RawMessage(`{"code":-32603,"message":"history store unavailable"}`),
		},
		{
			name: "retained rollout contains the accepted turn", currentBoot: replacementBoot, retainedBoot: true,
			historyError:    unsupportedHistory,
			retainedHistory: json.RawMessage(`{"data":[{"turnId":"turn-1","item":{"type":"userMessage","clientId":"11111111-1111-4111-8111-111111111111"}}]}`),
		},
		{
			name: "unsupported history from the same boot", boot: originalBoot, currentBoot: originalBoot,
			historyError: unsupportedHistory,
		},
		{
			name: "native history read failure", currentBoot: replacementBoot, retainedBoot: true,
			historyError: json.RawMessage(`{"code":-32603,"message":"failed to read history"}`),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			original, writer := readyCodexSupervisor(t)
			original.bootID = test.boot
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			dispatched := make(chan error, 1)
			go func() {
				_, err := original.call(ctx, "turn/start", json.RawMessage(operationParams))
				dispatched <- err
			}()
			readCodexWireRequest(t, writer)
			cancel()
			if err := <-dispatched; !errors.Is(err, errCodexOperationUnknown) {
				t.Fatalf("expected an unconfirmed dispatch: %v", err)
			}
			original.close()

			replacement, writer := readyCodexSupervisor(t)
			replacement.cwd = original.cwd
			replacement.bootID = test.currentBoot
			replacement.retainedBoot = test.retainedBoot
			ctx, cancel = context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result := make(chan error, 1)
			expected := `{"outcome":"unconfirmed"}`
			if test.retainedHistory != nil {
				expected = `{"turn":{"id":"turn-1","status":"inProgress"}}`
			}
			go func() {
				recovered, err := replacement.call(ctx, "tengri/reconcileOperation", json.RawMessage(reconcile))
				if err == nil && string(recovered.result) != expected {
					err = fmt.Errorf("unexpected recovery result %s", recovered.result)
				}
				result <- err
			}()
			request := readCodexWireRequest(t, writer)
			if request.Method != "thread/items/list" {
				t.Fatalf("recovery must read history without dispatching: %s", request.Method)
			}
			if test.historyError != nil {
				replacement.resolveResponse(codexRPCMessage{ID: request.ID, Error: test.historyError})
			} else {
				replacement.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"data":[]}`)})
			}
			if test.resumeError != nil || test.retainedHistory != nil {
				select {
				case err := <-result:
					t.Fatalf("recovery did not check for the exact rollout: %v", err)
				case message := <-writer.messages:
					if err := json.Unmarshal(message, &request); err != nil || request.Method != "thread/resume" {
						t.Fatalf("recovery must only resume the retained thread: %s", message)
					}
					thread, valid := codexThreadID(request.Params)
					if !valid || thread != "thread-1" {
						t.Fatalf("recovery did not check the original conversation: %s", message)
					}
				case <-ctx.Done():
					t.Fatal("timed out waiting for the native rollout check")
				}
				if test.resumeError != nil {
					replacement.resolveResponse(codexRPCMessage{ID: request.ID, Error: test.resumeError})
				} else {
					replacement.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"thread":{"id":"thread-1"}}`)})
					request = readCodexWireRequest(t, writer)
					if request.Method != "thread/items/list" {
						t.Fatalf("opening a retained thread must only retry its history: %s", request.Method)
					}
					replacement.resolveResponse(codexRPCMessage{ID: request.ID, Result: test.retainedHistory})
				}
			}
			err := <-result
			if !test.wantReleased && test.retainedHistory == nil {
				if !errors.Is(err, errCodexOperationUnknown) {
					t.Fatalf("operation with no cold-boot proof was released: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			repeated, err := replacement.call(ctx, "turn/start", json.RawMessage(operationParams))
			if err != nil || string(repeated.result) != expected {
				t.Fatalf("the same operation must return its recovered outcome: %s %v", repeated.result, err)
			}
			go func() {
				_, err := replacement.call(ctx, "turn/start", json.RawMessage(strings.ReplaceAll(operationParams, "11111111", "22222222")))
				result <- err
			}()
			request = readCodexWireRequest(t, writer)
			if request.Method != "turn/start" || !strings.Contains(string(request.Params), "22222222") {
				t.Fatalf("only a new operation may dispatch after recovery: %+v", request)
			}
			replacement.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"turn-2"}}`)})
			if err := <-result; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCodexOperationRejectsChangedPayloadBeforeDispatch(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	acceptOperation(t, supervisor, writer)
	changed := strings.Replace(operationParams, "Create the requested file", "Delete a different file", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := supervisor.call(ctx, "turn/start", json.RawMessage(changed))
	if err == nil || !strings.Contains(err.Error(), "different input") {
		t.Fatalf("changed operation must fail before dispatch: %v", err)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("changed payload reached Codex: %s", request)
	default:
	}
}

func TestCodexOperationRetrySurvivesSupervisorReplacement(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	accepted := acceptOperation(t, supervisor, writer)
	replacement := newCodexSupervisor("/usr/bin/false", supervisor.cwd)
	replacementWriter := &codexWireWriter{messages: make(chan []byte, 1)}
	replacement.stdin = replacementWriter
	closeSignal(replacement.generation.ready)
	t.Cleanup(replacement.close)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	repeated, err := replacement.call(ctx, "turn/start", json.RawMessage(operationParams))
	if err != nil || string(repeated.result) != string(accepted.result) {
		t.Fatalf("replacement must recover the committed turn, result=%s error=%v", repeated.result, err)
	}
	select {
	case request := <-replacementWriter.messages:
		t.Fatalf("replacement dispatched another request: %s", request)
	default:
	}
}

func TestCodexUnsentOperationReconcilesAndUnblocksConversation(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	<-supervisor.writePermit
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams))
		done <- err
	}()
	path := filepath.Join(supervisor.cwd, ".tengri", "codex-operations", "11111111-1111-4111-8111-111111111111.json")
	deadline := time.After(5 * time.Second)
	for {
		supervisor.mu.Lock()
		pending := len(supervisor.workRequests) == 1
		supervisor.mu.Unlock()
		if pending {
			break
		}
		select {
		case <-deadline:
			t.Fatal("operation never reached the native write gate")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	if err := <-done; !errors.Is(err, errCodexOperationRejected) {
		t.Fatalf("unsent operation remained uncertain: %v", err)
	}
	supervisor.writePermit <- struct{}{}
	if receipt, err := readCodexOperation(path); err != nil || receipt.State != "completed" || len(receipt.Error) == 0 {
		t.Fatalf("definite rejection was not persisted: %+v, %v", receipt, err)
	}
	if _, err := supervisor.call(context.Background(), "tengri/reconcileOperation", json.RawMessage(`{"operationId":"11111111-1111-4111-8111-111111111111","threadId":"thread-1"}`)); !errors.Is(err, errCodexOperationRejected) {
		t.Fatalf("reconciliation did not report the recorded rejection: %v", err)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("cancelled operation reached Codex: %s", request)
	default:
	}
	other := strings.ReplaceAll(operationParams, "11111111", "22222222")
	go func() {
		_, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(other))
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	if request.Method != "turn/start" || !strings.Contains(string(request.Params), "22222222") {
		t.Fatalf("next request did not dispatch: %+v", request)
	}
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"turn-2"}}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCodexOperationLostResponseBlocksResendAndNewIdentity(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams))
		done <- err
	}()
	readCodexWireRequest(t, writer)
	cancel()
	if err := <-done; !strings.Contains(err.Error(), "needs reconciliation") {
		t.Fatalf("lost response must retain an uncertain outcome: %v", err)
	}
	for _, params := range []string{operationParams, strings.Replace(operationParams, "11111111", "22222222", 1)} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(params))
		cancel()
		if err == nil || !strings.Contains(err.Error(), "needs reconciliation") {
			t.Fatalf("uncertain operation must block automatic dispatch: %v", err)
		}
	}
	select {
	case request := <-writer.messages:
		var message codexRPCMessage
		if json.Unmarshal(request, &message) != nil || message.Method != "thread/items/list" {
			t.Fatalf("uncertain operation caused another effect: %s", request)
		}
	default:
	}
}

func TestCodexUncertainOperationDoesNotBlockAnotherConversation(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	first := make(chan error, 1)
	go func() {
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams))
		first <- err
	}()
	readCodexWireRequest(t, writer)
	otherThread := strings.ReplaceAll(operationParams, "thread-1", "thread-2")
	other := strings.ReplaceAll(otherThread, "11111111", "22222222")
	second := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(other))
		second <- err
	}()
	request := readCodexWireRequest(t, writer)
	if request.Method != "turn/start" || !strings.Contains(string(request.Params), `"threadId":"thread-2"`) {
		t.Fatalf("another conversation did not dispatch independently: %+v", request)
	}
	response, _ := json.Marshal(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"turn-2","status":"inProgress"}}`)})
	supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(string(response)+"\n"), codexProtocolLineMaxBytes)
	if err := <-second; err != nil {
		t.Fatalf("another conversation was blocked by the uncertain turn: %v", err)
	}
	if _, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(otherThread)); !errors.Is(err, errCodexOperationConflict) {
		t.Fatalf("another conversation reused the active operation ID: %v", err)
	}
	cancel()
	if err := <-first; !errors.Is(err, errCodexOperationUnknown) {
		t.Fatalf("first conversation must remain uncertain: %v", err)
	}
	newIdentity := strings.ReplaceAll(operationParams, "11111111", "33333333")
	if _, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(newIdentity)); !errors.Is(err, errCodexOperationUnknown) {
		t.Fatalf("the uncertain conversation lost its own fence: %v", err)
	}
}

func TestCodexOperationKeepsAcceptanceAfterCallerTimesOut(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams))
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	cancel()
	if err := <-done; !errors.Is(err, errCodexOperationUnknown) {
		t.Fatalf("operation must remain unconfirmed before the late reply: %v", err)
	}
	accepted := json.RawMessage(`{"turn":{"id":"turn-1","status":"inProgress"}}`)
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: accepted})
	path := filepath.Join(supervisor.cwd, ".tengri", "codex-operations", "11111111-1111-4111-8111-111111111111.json")
	deadline := time.After(5 * time.Second)
	for {
		receipt, err := readCodexOperation(path)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.State == "completed" {
			break
		}
		select {
		case <-deadline:
			t.Fatal("native acceptance was lost after caller timeout")
		case <-time.After(time.Millisecond):
		}
	}
	recovered, err := supervisor.call(context.Background(), "tengri/reconcileOperation", json.RawMessage(`{"operationId":"11111111-1111-4111-8111-111111111111","threadId":"thread-1"}`))
	if err != nil || string(recovered.result) != string(accepted) {
		t.Fatalf("recovery did not use the late native acceptance: %s, %v", recovered.result, err)
	}
	select {
	case unexpected := <-writer.messages:
		t.Fatalf("recovery made another native call: %s", unexpected)
	default:
	}
}

func TestCodexOperationReconcilesLostAcceptanceByClientIdentityWithoutResending(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := supervisor.call(ctx, "turn/start", json.RawMessage(operationParams)); done <- err }()
	readCodexWireRequest(t, writer)
	cancel()
	<-done
	go func() {
		result, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
		if err == nil && !strings.Contains(string(result.result), "accepted-turn") {
			err = errors.New("wrong turn recovered")
		}
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	if request.Method != "thread/items/list" {
		t.Fatalf("recovery dispatched %s", request.Method)
	}
	response, _ := json.Marshal(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"data":[{"turnId":"accepted-turn","item":{"type":"userMessage","clientId":"11111111-1111-4111-8111-111111111111"}}],"nextCursor":null}`)})
	supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(string(response)+"\n"), codexProtocolLineMaxBytes)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams)); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("committed reconciliation resent a request: %s", request)
	default:
	}
}

func TestCodexApprovalIdentityCannotCrossProcessGeneration(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	message := codexRPCMessage{ID: json.RawMessage(`17`), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"threadId":"thread-1","turnId":"turn-1","command":"echo fixture"}`)}
	raw, _ := json.Marshal(message)
	supervisor.handleServerMessage(supervisor.generation, message, raw)
	old := supervisor.buffer[0].ApprovalID
	supervisor.mu.Lock()
	supervisor.generation = newCodexProcessGeneration()
	supervisor.approvals = make(map[string]codexApproval)
	supervisor.mu.Unlock()
	supervisor.handleServerMessage(supervisor.generation, message, raw)
	if old == supervisor.buffer[1].ApprovalID {
		t.Fatal("approval identity was reused after process replacement")
	}
	if err := supervisor.resolveApproval(context.Background(), old, "approveOnce"); err == nil {
		t.Fatal("stale approval authorized a new request")
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("stale approval wrote a response: %s", request)
	default:
	}
}

func TestCodexApprovalResponseRetryUsesCommittedReceipt(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	message := codexRPCMessage{ID: json.RawMessage(`17`), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"threadId":"thread-1","turnId":"turn-1","command":"echo fixture"}`)}
	raw, _ := json.Marshal(message)
	supervisor.handleServerMessage(supervisor.generation, message, raw)
	params, _ := json.Marshal(map[string]any{"threadId": "thread-1", "expectedTurnId": "turn-1", "approvalId": supervisor.buffer[0].ApprovalID, "clientUserMessageId": "22222222-2222-4222-8222-222222222222", "decision": "approveOnce"})
	if _, err := supervisor.call(context.Background(), "tengri/resolveApproval", params); err != nil {
		t.Fatal(err)
	}
	readCodexWireRequest(t, writer)
	if _, err := supervisor.call(context.Background(), "tengri/resolveApproval", params); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("approval retry wrote again: %s", request)
	default:
	}
}

func TestCodexOperationConcurrentRetriesDispatchOnce(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	var group sync.WaitGroup
	results := make(chan error, 8)
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
			results <- err
		}()
	}
	request := readCodexWireRequest(t, writer)
	response, _ := json.Marshal(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"turn-1","status":"inProgress"}}`)})
	supervisor.readMessagesWithLimit(nil, supervisor.generation, strings.NewReader(string(response)+"\n"), codexProtocolLineMaxBytes)
	group.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("concurrent retries dispatched again: %s", request)
	default:
	}
}

func TestCodexProcessExitRetainsDispatchForAcceptanceReconciliation(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
		done <- err
	}()
	readCodexWireRequest(t, writer)
	supervisor.failProcess(errors.New("fixture process exited after request write"))
	if err := <-done; !errors.Is(err, errCodexOperationUnknown) || errors.Is(err, errCodexOperationRejected) {
		t.Fatalf("process exit was treated as a native rejection: %v", err)
	}
	receipt, err := readCodexOperation(filepath.Join(supervisor.cwd, ".tengri", "codex-operations", "11111111-1111-4111-8111-111111111111.json"))
	if err != nil || receipt.State != "dispatching" || len(receipt.Error) != 0 {
		t.Fatalf("process exit closed acceptance recovery: %+v %v", receipt, err)
	}
	supervisor.mu.Lock()
	supervisor.stdin = writer
	closeSignal(supervisor.generation.ready)
	supervisor.mu.Unlock()
	go func() {
		_, err := supervisor.call(context.Background(), "tengri/reconcileOperation", json.RawMessage(`{"operationId":"11111111-1111-4111-8111-111111111111","threadId":"thread-1"}`))
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	if request.Method != "thread/items/list" {
		t.Fatalf("recovery resent %s", request.Method)
	}
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"data":[{"turnId":"accepted-before-exit","item":{"type":"userMessage","clientId":"11111111-1111-4111-8111-111111111111"}}],"nextCursor":null}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCodexNativeRejectionIsDistinctFromAnUncertainServerFailure(t *testing.T) {
	for _, code := range []int{-32600, -32601, -32602, -32603} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			supervisor, writer := readyCodexSupervisor(t)
			done := make(chan error, 1)
			go func() {
				_, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
				done <- err
			}()
			request := readCodexWireRequest(t, writer)
			raw, _ := json.Marshal(map[string]any{"code": code, "message": "fixture rejection"})
			supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Error: raw})
			err := <-done
			if code == -32603 {
				if !errors.Is(err, errCodexOperationUnknown) {
					t.Fatalf("uncertain native failure was closed: %v", err)
				}
				return
			}
			if !errors.Is(err, errCodexOperationRejected) {
				t.Fatalf("definite rejection was lost: %v", err)
			}
			_, err = supervisor.call(context.Background(), "turn/start", json.RawMessage(operationParams))
			if !errors.Is(err, errCodexOperationRejected) {
				t.Fatalf("rejected retry changed outcome: %v", err)
			}
			select {
			case request := <-writer.messages:
				t.Fatalf("rejected retry resent %s", request)
			default:
			}
		})
	}
}

func TestCodexTerminalReceiptSurvivesGenerationReplacement(t *testing.T) {
	for _, status := range []string{"failed", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			supervisor, writer := readyCodexSupervisor(t)
			acceptOperation(t, supervisor, writer)
			emitCodexServerEvent(t, supervisor, "turn/started", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1"}})
			params, _ := json.Marshal(map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": status}})
			message := codexRPCMessage{Method: "turn/completed", Params: params}
			raw, _ := json.Marshal(message)
			supervisor.handleServerMessage(supervisor.generation, message, raw)
			deadline := time.Now().Add(time.Second)
			for supervisor.terminalStatus("thread-1", "turn-1", supervisor.generation.id) == "" && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			replacement := newCodexSupervisor("/usr/bin/false", supervisor.cwd)
			result, err := replacement.call(context.Background(), "tengri/operation", json.RawMessage(`{"operationId":"11111111-1111-4111-8111-111111111111","threadId":"thread-1","turnId":"turn-1"}`))
			var value struct {
				Alive    bool   `json:"generationAlive"`
				Terminal string `json:"terminalStatus"`
			}
			if err != nil || json.Unmarshal(result.result, &value) != nil || value.Alive || value.Terminal != status {
				t.Fatalf("confirmed outcome was lost: %s %v", result.result, err)
			}
			if replacement.terminalStatus("thread-1", "turn-1", replacement.generation.id) != "" {
				t.Fatal("a new generation inherited an old terminal receipt")
			}
		})
	}
}
