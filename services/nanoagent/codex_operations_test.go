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
				_, err := supervisor.dispatchOperation(ctx, test.method, json.RawMessage(operationParams))
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
