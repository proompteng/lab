package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func emitCodexServerEvent(t *testing.T, supervisor *codexSupervisor, method string, params any) {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	message := codexRPCMessage{Method: method, Params: encoded}
	raw, _ := json.Marshal(message)
	supervisor.handleServerMessage(supervisor.generation, message, raw)
}

func replyCodexResult(supervisor *codexSupervisor, request codexRPCMessage, result string) {
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(result)})
}

func TestInterruptedTurnWaitsForCommandCleanupAndPreservesOtherTurns(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	generation := supervisor.generation
	emitCodexServerEvent(t, supervisor, "turn/started", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1"}})
	emitCodexServerEvent(t, supervisor, "item/started", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "owned-command", "type": "commandExecution"}})
	emitCodexServerEvent(t, supervisor, "turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "interrupted"}})
	emitCodexServerEvent(t, supervisor, "thread/status/changed", map[string]any{"threadId": "thread-1", "status": map[string]string{"type": "idle"}})
	if supervisor.terminalStatus("thread-1", "turn-1", generation.id) != "" {
		t.Fatal("interruption was confirmed before command cleanup")
	}
	if activity := supervisor.activitySnapshot(); activity == nil || !activity.Working {
		t.Fatalf("pending cleanup did not inhibit idle sleep: %+v", activity)
	}
	request := readCodexWireRequest(t, writer)
	if request.Method != "thread/backgroundTerminals/list" {
		t.Fatalf("cleanup started with %q", request.Method)
	}
	replyCodexResult(supervisor, request, `{"data":[{"itemId":"previous-turn-command","processId":"keep-running"},{"itemId":"owned-command","processId":"stop-this"}],"nextCursor":"next-page"}`)
	request = readCodexWireRequest(t, writer)
	var page struct {
		Thread string `json:"threadId"`
		Cursor string `json:"cursor"`
	}
	if request.Method != "thread/backgroundTerminals/list" || json.Unmarshal(request.Params, &page) != nil || page.Thread != "thread-1" || page.Cursor != "next-page" {
		t.Fatalf("cleanup did not finish the inventory before termination: %+v", request)
	}
	replyCodexResult(supervisor, request, `{"data":[],"nextCursor":null}`)
	request = readCodexWireRequest(t, writer)
	var target struct {
		Thread  string `json:"threadId"`
		Process string `json:"processId"`
	}
	if request.Method != "thread/backgroundTerminals/terminate" || json.Unmarshal(request.Params, &target) != nil || target.Thread != "thread-1" || target.Process != "stop-this" {
		t.Fatalf("cleanup targeted another command: %+v", request)
	}
	if supervisor.terminalStatus("thread-1", "turn-1", generation.id) != "" {
		t.Fatal("an unacknowledged termination confirmed cancellation")
	}
	replyCodexResult(supervisor, request, `{"terminated":true}`)
	request = readCodexWireRequest(t, writer)
	if request.Method != "thread/backgroundTerminals/list" {
		t.Fatal("cleanup did not verify the remaining inventory")
	}
	replyCodexResult(supervisor, request, `{"data":[{"itemId":"previous-turn-command","processId":"keep-running"}],"nextCursor":null}`)
	deadline := time.Now().Add(3 * time.Second)
	for (supervisor.terminalStatus("thread-1", "turn-1", generation.id) == "" || supervisor.activitySnapshot().Working) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if supervisor.terminalStatus("thread-1", "turn-1", generation.id) != "interrupted" {
		t.Fatal("confirmed command cleanup did not persist cancellation")
	}
	if activity := supervisor.activitySnapshot(); activity == nil || activity.Working {
		t.Fatalf("confirmed cleanup did not release idle activity: %+v", activity)
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("cleanup touched another turn: %s", request)
	default:
	}
}

func TestInterruptedTurnFailsClosedWithoutCompleteCommandOwnership(t *testing.T) {
	for _, omitted := range []bool{false, true} {
		supervisor, writer := readyCodexSupervisor(t)
		if omitted {
			emitCodexServerEvent(t, supervisor, "turn/started", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1"}})
			supervisor.markWorkUnknown(supervisor.generation)
		}
		emitCodexServerEvent(t, supervisor, "turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "interrupted"}})
		if supervisor.terminalStatus("thread-1", "turn-1", supervisor.generation.id) != "" || supervisor.activitySnapshot() != nil {
			t.Fatal("incomplete command ownership confirmed cancellation or idle state")
		}
		select {
		case request := <-writer.messages:
			t.Fatalf("missing ownership dispatched cleanup: %s", request)
		default:
		}
	}
}

func TestCommandCleanupRejectsMalformedInventory(t *testing.T) {
	for _, response := range []string{`{}`, `{"data":null}`, `{"data":[{"itemId":"command","processId":""}]}`} {
		supervisor, writer := readyCodexSupervisor(t)
		done := make(chan error, 1)
		go func() {
			done <- supervisor.stopTurnCommands(context.Background(), supervisor.generation, codexTurnIdentity{thread: "thread-1", turn: "turn-1"}, map[string]struct{}{"command": {}})
		}()
		request := readCodexWireRequest(t, writer)
		replyCodexResult(supervisor, request, response)
		if err := <-done; err == nil {
			t.Fatalf("malformed inventory was accepted: %s", response)
		}
		select {
		case request := <-writer.messages:
			t.Fatalf("malformed inventory dispatched an effect: %s", request)
		default:
		}
	}
}

func TestCommandCleanupRejectsAProcessThatRemainsAfterTermination(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	done := make(chan error, 1)
	go func() {
		done <- supervisor.stopTurnCommands(context.Background(), supervisor.generation, codexTurnIdentity{thread: "thread-1", turn: "turn-1"}, map[string]struct{}{"command": {}})
	}()
	inventory := `{"data":[{"itemId":"command","processId":"still-running"}],"nextCursor":null}`
	replyCodexResult(supervisor, readCodexWireRequest(t, writer), inventory)
	request := readCodexWireRequest(t, writer)
	if request.Method != "thread/backgroundTerminals/terminate" {
		t.Fatalf("cleanup method = %q", request.Method)
	}
	replyCodexResult(supervisor, request, `{"terminated":true}`)
	replyCodexResult(supervisor, readCodexWireRequest(t, writer), inventory)
	if err := <-done; err == nil {
		t.Fatal("a termination acknowledgement replaced process absence proof")
	}
}

func TestInterruptedTurnRetriesFailedCleanupWithoutReleasingActivity(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	generation := supervisor.generation
	emitCodexServerEvent(t, supervisor, "turn/started", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1"}})
	emitCodexServerEvent(t, supervisor, "item/started", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "command", "type": "commandExecution"}})
	emitCodexServerEvent(t, supervisor, "turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "interrupted"}})
	replyCodexResult(supervisor, readCodexWireRequest(t, writer), `{}`)
	if supervisor.terminalStatus("thread-1", "turn-1", generation.id) != "" || !supervisor.activitySnapshot().Working {
		t.Fatal("failed cleanup released the turn")
	}
	var request codexRPCMessage
	select {
	case raw := <-writer.messages:
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("command cleanup was not retried")
	}
	if request.Method != "thread/backgroundTerminals/list" {
		t.Fatalf("retry method = %q", request.Method)
	}
	replyCodexResult(supervisor, request, `{"data":[],"nextCursor":null}`)
	replyCodexResult(supervisor, readCodexWireRequest(t, writer), `{"data":[],"nextCursor":null}`)
	deadline := time.Now().Add(time.Second)
	for supervisor.terminalStatus("thread-1", "turn-1", generation.id) == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if supervisor.terminalStatus("thread-1", "turn-1", generation.id) != "interrupted" {
		t.Fatal("successful retry did not confirm cancellation")
	}
}

func TestCommandCleanupNeverTargetsAReplacementGeneration(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	generation := supervisor.generation
	supervisor.failProcess(errors.New("process exited"))
	supervisor.stdin = writer
	closeSignal(supervisor.generation.ready)
	if err := supervisor.stopTurnCommands(context.Background(), generation, codexTurnIdentity{thread: "thread-1", turn: "turn-1"}, map[string]struct{}{"command": {}}); err == nil {
		t.Fatal("cleanup accepted a replacement generation")
	}
	select {
	case request := <-writer.messages:
		t.Fatalf("old cleanup reached the replacement process: %s", request)
	default:
	}
}

func TestInterruptedReceiptRequiresCurrentSchemaAndConfirmedCleanup(t *testing.T) {
	supervisor, _ := readyCodexSupervisor(t)
	for _, receipt := range []codexTerminalReceipt{
		{Version: 1, Status: "interrupted", ProcessesStopped: true},
		{Version: 2, Status: "interrupted"},
		{Version: 2, Status: "interrupted", ProcessesStopped: true},
	} {
		receipt.Thread, receipt.Turn, receipt.Generation = "thread-1", "turn-1", supervisor.generation.id
		path := supervisor.terminalPath(receipt.Thread, receipt.Turn, receipt.Generation)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := writeCodexReceipt(path, receipt); err != nil {
			t.Fatal(err)
		}
		confirmed := supervisor.terminalStatus(receipt.Thread, receipt.Turn, receipt.Generation) == "interrupted"
		if confirmed != (receipt.Version == 2 && receipt.ProcessesStopped) {
			t.Fatalf("invalid cleanup confirmation: %+v", receipt)
		}
	}
}
