package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestPinnedCodexRecoversAcceptanceFromPersistedClientIdentity(t *testing.T) {
	for _, process := range []bool{false, true} {
		name := "model request"
		if process {
			name = "running command"
		}
		t.Run(name, func(t *testing.T) { testPinnedCodexRecoversAcceptance(t, process) })
	}
}

func TestPinnedCodexArchivesAndRestoresPersistedHistory(t *testing.T) {
	binary := os.Getenv("TENGRI_CODEX_CONTRACT_BINARY")
	if binary == "" {
		t.Skip("set TENGRI_CODEX_CONTRACT_BINARY to the pinned Codex 0.164.0 binary")
	}
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("OPENAI_API_KEY", "")
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(response, `{"error":{"message":"Local archive fixture","type":"invalid_request_error"}}`)
	}))
	t.Cleanup(provider.Close)
	config := fmt.Sprintf(`model = "fixture"
model_provider = "fixture"
[model_providers.fixture]
name = "Fixture"
base_url = %q
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`, provider.URL)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	supervisor := newCodexSupervisor(binary, workspace)
	supervisor.start()
	t.Cleanup(supervisor.close)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	call := func(method string, input any) json.RawMessage {
		t.Helper()
		params, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		result, err := supervisor.call(ctx, method, params)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		return result.result
	}
	var created struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(call("thread/start", map[string]any{"model": "fixture", "cwd": workspace, "historyMode": "paginated"}), &created); err != nil || created.Thread.ID == "" {
		t.Fatal("native thread creation failed", err)
	}
	subscription, events, err := supervisor.subscribe(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { supervisor.unsubscribe(subscription) })
	params := json.RawMessage(strings.Replace(operationParams, "thread-1", created.Thread.ID, 1))
	call("turn/start", params)
	for {
		select {
		case event := <-events:
			var notice struct {
				Params struct {
					ThreadID string `json:"threadId"`
				} `json:"params"`
			}
			if event.Method == "turn/completed" && json.Unmarshal(event.Raw, &notice) == nil && notice.Params.ThreadID == created.Thread.ID {
				goto completed
			}
		case <-ctx.Done():
			t.Fatal("native archive fixture did not finish")
		}
	}
completed:
	listed := func(archived bool) bool {
		t.Helper()
		var page struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(call("thread/list", map[string]any{"archived": archived, "limit": 50}), &page); err != nil {
			t.Fatal(err)
		}
		for _, thread := range page.Data {
			if thread.ID == created.Thread.ID {
				return true
			}
		}
		return false
	}
	if !listed(false) || listed(true) {
		t.Fatal("new thread was not in the active index")
	}
	thread := map[string]any{"threadId": created.Thread.ID}
	call("thread/archive", thread)
	if listed(false) || !listed(true) {
		t.Fatal("archive did not move the persisted thread")
	}
	call("thread/unarchive", thread)
	if !listed(false) || listed(true) {
		t.Fatal("restore did not return the persisted thread")
	}
	var history struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(call("thread/turns/list", map[string]any{"threadId": created.Thread.ID, "limit": 50, "itemsView": "notLoaded"}), &history); err != nil || len(history.Data) != 1 || history.Data[0].ID == "" {
		t.Fatal("archive lost the original turn", err)
	}
}

func testPinnedCodexRecoversAcceptance(t *testing.T, process bool) {
	binary := os.Getenv("TENGRI_CODEX_CONTRACT_BINARY")
	if binary == "" {
		t.Skip("set TENGRI_CODEX_CONTRACT_BINARY to the pinned Codex 0.164.0 binary")
	}
	version, err := exec.Command(binary, "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != "codex-cli 0.164.0" {
		t.Fatalf("wrong native contract binary: %s %v", version, err)
	}
	home := t.TempDir()
	workspace := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	started := make(chan struct{}, 1)
	stopped := make(chan struct{}, 1)
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	deadline, _ := ctx.Deadline()
	_ = listener.SetDeadline(deadline)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != "POST" || !strings.HasSuffix(request.URL.Path, "/responses") {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.Copy(io.Discard, request.Body)
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		if requestNumber := requests.Add(1); process && requestNumber == 1 {
			command := fmt.Sprintf(`exec python3 -c 'import json,os,socket,time; open("native-command-marker", "w").write("guest workspace"); s=socket.create_connection(("127.0.0.1",%d)); s.sendall(json.dumps({"pid":os.getpid(),"cwd":os.getcwd()}).encode()+bytes([10])); time.sleep(30)'`, listener.Addr().(*net.TCPAddr).Port)
			arguments, _ := json.Marshal(map[string]any{"cmd": command, "yield_time_ms": 1_000, "max_output_tokens": 100})
			item := map[string]any{"id": "command-stop", "type": "function_call", "call_id": "call_stop", "name": "exec_command", "arguments": string(arguments)}
			for _, event := range []map[string]any{
				{"type": "response.created", "response": map[string]any{"id": "response-stop"}},
				{"type": "response.output_item.added", "output_index": 0, "item": item},
				{"type": "response.output_item.done", "output_index": 0, "item": item},
				{"type": "response.completed", "response": map[string]any{"id": "response-stop", "status": "completed", "output": []any{item}}},
			} {
				encoded, _ := json.Marshal(event)
				_, _ = fmt.Fprintf(response, "event: %s\ndata: %s\n\n", event["type"], encoded)
			}
			return
		}
		response.(http.Flusher).Flush()
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-request.Context().Done():
		case <-ctx.Done():
		}
		select {
		case stopped <- struct{}{}:
		default:
		}
	}))
	t.Cleanup(provider.Close)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("OPENAI_API_KEY", "")
	config := fmt.Sprintf(`model = "fixture"
model_provider = "fixture"
[features]
apps = true
[model_providers.fixture]
name = "Fixture"
base_url = %q
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`, provider.URL)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	supervisor := newCodexSupervisor(binary, workspace)
	supervisor.start()
	t.Cleanup(supervisor.close)
	assertAppsDisabled := func() {
		t.Helper()
		result, err := supervisor.request(ctx, "config/read", json.RawMessage(`{"includeLayers":false}`), true, nil)
		var settings struct {
			Config struct {
				Features struct {
					Apps *bool `json:"apps"`
				} `json:"features"`
			} `json:"config"`
		}
		if err != nil || json.Unmarshal(result.result, &settings) != nil || settings.Config.Features.Apps == nil || *settings.Config.Features.Apps {
			t.Fatalf("native Codex retained inherited app tools: %s, error: %v", result.result, err)
		}
	}
	assertAppsDisabled()
	raw, _ := json.Marshal(map[string]any{"model": "fixture", "modelProvider": "fixture", "cwd": workspace, "historyMode": "paginated", "approvalPolicy": "on-request", "sandbox": "danger-full-access", "config": map[string]any{"features.apps": true}})
	result, err := supervisor.call(ctx, "thread/start", raw)
	if err != nil {
		t.Fatal(err)
	}
	var thread struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if json.Unmarshal(result.result, &thread) != nil || thread.Thread.ID == "" {
		t.Fatalf("invalid native thread: %s", result.result)
	}
	invalid := strings.Replace(operationParams, "thread-1", "00000000-0000-4000-8000-000000000000", 1)
	invalid = strings.Replace(invalid, "11111111-1111-4111-8111-111111111111", "99999999-9999-4999-8999-999999999999", 1)
	if _, err := supervisor.call(ctx, "turn/start", json.RawMessage(invalid)); !errors.Is(err, errCodexOperationRejected) {
		t.Fatalf("native missing-thread rejection was not classified: %v", err)
	}
	params := strings.Replace(operationParams, "thread-1", thread.Thread.ID, 1)
	accepted, err := supervisor.call(ctx, "turn/start", json.RawMessage(params))
	if err != nil {
		t.Fatal(err)
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(accepted.result, &turn) != nil || turn.Turn.ID == "" {
		t.Fatalf("invalid native turn: %s", accepted.result)
	}
	path := filepath.Join(workspace, ".tengri", "codex-operations", "11111111-1111-4111-8111-111111111111.json")
	receipt, err := readCodexOperation(path)
	if err != nil {
		t.Fatal(err)
	}
	// Model the crash window after Codex accepted the turn but before its response was committed.
	receipt.State = "dispatching"
	receipt.Result = nil
	if err := writeCodexOperation(path, receipt); err != nil {
		t.Fatal(err)
	}
	for {
		recovered, err := supervisor.call(ctx, "turn/start", json.RawMessage(params))
		if err == nil {
			var recoveredTurn struct {
				Turn struct {
					ID string `json:"id"`
				} `json:"turn"`
			}
			if json.Unmarshal(recovered.result, &recoveredTurn) != nil || recoveredTurn.Turn.ID != turn.Turn.ID {
				t.Fatalf("recovery changed the native turn: %s", recovered.result)
			}
			break
		}
		if ctx.Err() != nil {
			t.Fatal("native client identity did not become recoverable", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	interrupt, _ := json.Marshal(map[string]any{"threadId": thread.Thread.ID, "turnId": turn.Turn.ID, "clientUserMessageId": "22222222-2222-4222-8222-222222222222"})
	var connection net.Conn
	if process {
		connection, err = listener.Accept()
		if err != nil {
			t.Fatal("native foreground command did not start", err)
		}
		t.Cleanup(func() { _ = connection.Close() })
		line, err := bufio.NewReader(connection).ReadBytes('\n')
		if err != nil {
			t.Fatal("native command did not report its PID", err)
		}
		var command struct {
			PID int    `json:"pid"`
			Cwd string `json:"cwd"`
		}
		expectedWorkspace, err := filepath.EvalSymlinks(workspace)
		if err != nil || json.Unmarshal(line, &command) != nil || command.PID <= 0 || command.Cwd != expectedWorkspace {
			t.Fatalf("native command ran outside its guest workspace: %s, error: %v", line, err)
		}
		if marker, err := os.ReadFile(filepath.Join(workspace, "native-command-marker")); err != nil || string(marker) != "guest workspace" {
			t.Fatalf("native command did not write its guest workspace: %q, error: %v", marker, err)
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			params, _ := json.Marshal(map[string]any{"threadId": thread.Thread.ID})
			_, _ = supervisor.request(cleanup, "thread/backgroundTerminals/clean", params, true, nil)
		})
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("native model request did not reach the held loopback provider")
	}
	archive, _ := json.Marshal(map[string]any{"threadId": thread.Thread.ID})
	if _, err := supervisor.call(ctx, "thread/archive", archive); !errors.Is(err, errCodexThreadActive) {
		t.Fatalf("archive did not preserve the active native turn: %v", err)
	}
	if _, err := supervisor.call(ctx, "turn/interrupt", interrupt); err != nil {
		t.Fatal("native interrupt failed", err)
	}
	for {
		pageParams, _ := json.Marshal(map[string]any{"threadId": thread.Thread.ID, "limit": 100, "sortDirection": "desc", "itemsView": "notLoaded"})
		page, err := supervisor.call(ctx, "thread/turns/list", pageParams)
		if err != nil {
			t.Fatal(err)
		}
		var turns struct {
			Data []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"data"`
		}
		if json.Unmarshal(page.result, &turns) != nil {
			t.Fatal("invalid native turn page")
		}
		for _, observed := range turns.Data {
			if observed.ID == turn.Turn.ID && observed.Status == "interrupted" {
				select {
				case <-stopped:
					for supervisor.terminalStatus(thread.Thread.ID, turn.Turn.ID, receipt.Generation) != "interrupted" {
						if ctx.Err() != nil {
							t.Fatal("native terminal notification was not durably recorded")
						}
						time.Sleep(10 * time.Millisecond)
					}
					if connection != nil {
						_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
						if _, err := connection.Read(make([]byte, 1)); err != io.EOF {
							t.Fatalf("cancelled native turn left its command running: %v", err)
						}
					}
					requestsBeforeRestart := requests.Load()
					supervisor.mu.Lock()
					command, generation := supervisor.command, supervisor.generation
					supervisor.mu.Unlock()
					if err := command.Process.Signal(syscall.SIGTERM); err != nil {
						t.Fatal("terminate native app-server", err)
					}
					for {
						supervisor.mu.Lock()
						changed := supervisor.generation != generation
						supervisor.mu.Unlock()
						if changed && supervisor.isReady() {
							break
						}
						if ctx.Err() != nil {
							t.Fatal("native app-server never restarted")
						}
						time.Sleep(10 * time.Millisecond)
					}
					assertAppsDisabled()
					nextParams := json.RawMessage(strings.Replace(params, "11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444", 1))
					next, err := supervisor.call(ctx, "turn/start", nextParams)
					if err != nil {
						t.Fatal("new turn after native restart", err)
					}
					var nextTurn struct {
						Turn struct {
							ID string `json:"id"`
						} `json:"turn"`
					}
					if json.Unmarshal(next.result, &nextTurn) != nil || nextTurn.Turn.ID == "" || nextTurn.Turn.ID == turn.Turn.ID {
						t.Fatalf("restart did not create a fresh native turn: %s", next.result)
					}
					select {
					case <-started:
					case <-ctx.Done():
						t.Fatal("restarted native turn never reached the provider")
					}
					replayed, err := supervisor.call(ctx, "turn/start", nextParams)
					if err != nil || string(replayed.result) != string(next.result) || requests.Load() != requestsBeforeRestart+1 {
						t.Fatalf("restart replay duplicated the native turn: requests=%d error=%v", requests.Load(), err)
					}
					supervisor.mu.Lock()
					events := append([]codexEvent(nil), supervisor.buffer...)
					supervisor.mu.Unlock()
					for _, event := range events {
						if strings.Contains(string(event.Raw), "Full-history hydration is deprecated") {
							t.Fatalf("native restart requested deprecated full history: %s", event.Raw)
						}
					}
					nextInterrupt, _ := json.Marshal(map[string]any{"threadId": thread.Thread.ID, "turnId": nextTurn.Turn.ID, "clientUserMessageId": "55555555-5555-4555-8555-555555555555"})
					if _, err := supervisor.call(ctx, "turn/interrupt", nextInterrupt); err != nil {
						t.Fatal("interrupt restarted native turn", err)
					}
					return
				case <-ctx.Done():
					t.Fatal("turn interrupted but its model request was not cancelled")
				}
			}
		}
		if ctx.Err() != nil {
			t.Fatal("Stop never reached an authoritative terminal turn")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
