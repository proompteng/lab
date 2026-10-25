package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
)

func workEvent(t *testing.T, supervisor *codexSupervisor, method, params string) {
	t.Helper()
	message := codexRPCMessage{Method: method, Params: json.RawMessage(params)}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	supervisor.handleServerMessage(supervisor.generation, message, raw)
}

func TestCodexActivityTracksAllThreadsWithoutSubscribers(t *testing.T) {
	supervisor, _ := readyCodexSupervisor(t)
	supervisor.workChangedAt = time.Now().Add(-2 * time.Hour)
	before := supervisor.activitySnapshot()
	if before.Working || before.IdleForMs < 7_200_000 {
		t.Fatalf("initial idle = %+v", before)
	}
	for _, thread := range []string{"a", "b"} {
		workEvent(t, supervisor, "turn/started", `{"threadId":"`+thread+`","turn":{"id":"turn-`+thread+`"}}`)
	}
	if !supervisor.activitySnapshot().Working {
		t.Fatal("active turns must inhibit sleep without a subscriber")
	}
	workEvent(t, supervisor, "turn/completed", `{"threadId":"a","turn":{"id":"turn-a","status":"completed"}}`)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("another thread is still working")
	}
	workEvent(t, supervisor, "turn/completed", `{"threadId":"b","turn":{"id":"turn-b","status":"completed"}}`)
	after := supervisor.activitySnapshot()
	if after.Working || after.IdleForMs > 1000 {
		t.Fatalf("completion must start a fresh idle interval: %+v", after)
	}
	supervisor.workChangedAt = time.Now().Add(-time.Minute)
	for range 3 {
		supervisor.activitySnapshot()
		workEvent(t, supervisor, "thread/status/changed", `{"threadId":"a","status":{"type":"idle"}}`)
		workEvent(t, supervisor, "thread/closed", `{"threadId":"a"}`)
	}
	if supervisor.activitySnapshot().IdleForMs < 60_000 {
		t.Fatal("probes must not renew activity")
	}
}

func TestCodexActivityPendingStartSurvivesDisconnectedCaller(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.request(ctx, "turn/start", json.RawMessage(`{"threadId":"a"}`), true, nil)
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("pending start must inhibit sleep")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("call = %v", err)
	}
	if !supervisor.activitySnapshot().Working {
		t.Fatal("disconnect does not cancel a delivered start")
	}
	workEvent(t, supervisor, "turn/started", `{"threadId":"a","turn":{"id":"one"}}`)
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"one"}}`)})
	if !supervisor.activitySnapshot().Working {
		t.Fatal("the accepted turn is still working")
	}
	workEvent(t, supervisor, "turn/completed", `{"threadId":"a","turn":{"id":"one","status":"completed"}}`)
	if supervisor.activitySnapshot().Working {
		t.Fatal("finished turn is idle")
	}
}

func TestCodexActivityFailedStartAndLateCompletion(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.request(context.Background(), "turn/start", json.RawMessage(`{"threadId":"a"}`), true, nil)
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Error: json.RawMessage(`{"code":-1,"message":"rejected"}`)})
	if err := <-done; err == nil {
		t.Fatal("expected rejected start")
	}
	if supervisor.activitySnapshot().Working {
		t.Fatal("rejected starts do not leave permanent inhibition")
	}
	workEvent(t, supervisor, "turn/started", `{"threadId":"a","turn":{"id":"new"}}`)
	workEvent(t, supervisor, "turn/completed", `{"threadId":"a","turn":{"id":"old","status":"completed"}}`)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("late completion cannot clear a newer turn")
	}
	workEvent(t, supervisor, "thread/status/changed", `{"threadId":"a","status":{"type":"idle"}}`)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("thread idle cannot release an unfinished turn's command ownership")
	}
	workEvent(t, supervisor, "turn/completed", `{"threadId":"a","turn":{"id":"new","status":"completed"}}`)
	if supervisor.activitySnapshot().Working {
		t.Fatal("the matching terminal receipt clears work")
	}
}

func TestCodexActivityWaitingApprovalAndGenerationRecovery(t *testing.T) {
	supervisor, _ := readyCodexSupervisor(t)
	workEvent(t, supervisor, "thread/status/changed", `{"threadId":"a","status":{"type":"active","activeFlags":["waitingOnApproval"]}}`)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("waiting for approval remains active")
	}
	previous := supervisor.generation
	supervisor.failProcess(errors.New("fixture process ended"))
	if supervisor.activitySnapshot() != nil {
		t.Fatal("restarting process work state is unknown")
	}
	supervisor.stdin = &recordingWriteCloser{}
	closeSignal(supervisor.generation.ready)
	supervisor.observeWork(previous, codexRPCMessage{Method: "turn/started", Params: json.RawMessage(`{"threadId":"a","turn":{"id":"old"}}`)})
	if supervisor.activitySnapshot().Working {
		t.Fatal("old generations must not resurrect work")
	}
	workEvent(t, supervisor, "turn/started", `{"broken":true}`)
	if supervisor.activitySnapshot() != nil {
		t.Fatal("malformed work notifications must defer sleep")
	}
}

func TestGuestInfoReportsPrivateCodexWorkMetadata(t *testing.T) {
	supervisor, _ := readyCodexSupervisor(t)
	api := &apiServer{codex: supervisor}
	server := &guestRPCServer{api: api}
	workEvent(t, supervisor, "turn/started", `{"threadId":"a","turn":{"id":"one"}}`)
	info, err := server.GetInfo(context.Background(), &pb.Empty{})
	if err != nil || info.CodexActivity == nil || !info.CodexActivity.Working {
		t.Fatalf("info = %+v, %v", info, err)
	}
}

func TestCodexActivityCancelledBeforeWriteDoesNotRemainBusy(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	<-supervisor.writePermit
	defer func() { supervisor.writePermit <- struct{}{} }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.request(ctx, "turn/start", json.RawMessage(`{"threadId":"a"}`), true, nil)
		done <- err
	}()
	deadline := time.Now().Add(time.Second)
	for !supervisor.activitySnapshot().Working {
		if time.Now().After(deadline) {
			t.Fatal("start did not reach the write queue")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("call = %v", err)
	}
	if supervisor.activitySnapshot().Working {
		t.Fatal("an unsent cancelled request must not inhibit sleep forever")
	}
	if len(writer.messages) != 0 {
		t.Fatal("request should never have reached the app-server")
	}
}

func TestCodexActivityTracksDurableDispatchAndTerminalReceipt(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	done := make(chan error, 1)
	go func() {
		_, err := supervisor.call(context.Background(), "turn/start", json.RawMessage(`{"threadId":"a","clientUserMessageId":"11111111-1111-4111-8111-111111111111"}`))
		done <- err
	}()
	request := readCodexWireRequest(t, writer)
	if !supervisor.activitySnapshot().Working {
		t.Fatal("durable dispatch must inhibit sleep while awaiting acceptance")
	}
	workEvent(t, supervisor, "turn/started", `{"threadId":"a","turn":{"id":"one"}}`)
	supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"turn":{"id":"one"}}`)})
	if err := <-done; err != nil {
		t.Fatalf("durable dispatch: %v", err)
	}
	if !supervisor.activitySnapshot().Working {
		t.Fatal("accepted durable turn is still working")
	}
	workEvent(t, supervisor, "turn/completed", `{"threadId":"a","turn":{"id":"one","status":"completed"}}`)
	if supervisor.terminalStatus("a", "one", supervisor.generation.id) != "completed" {
		t.Fatal("terminal receipt must survive the merge")
	}
	if supervisor.activitySnapshot().Working {
		t.Fatal("durably completed turn should start the idle interval")
	}
}
