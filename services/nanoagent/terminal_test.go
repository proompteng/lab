package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

func TestTerminalOutputFrameIncludesTypeSequenceAndPayload(t *testing.T) {
	t.Parallel()
	frame := outputFrame(terminalChunk{sequence: 42, data: []byte("hello")})
	if frame[0] != outputFrameType || binary.BigEndian.Uint32(frame[1:5]) != 42 || string(frame[5:]) != "hello" {
		t.Fatalf("outputFrame() = %v", frame)
	}
}

func TestTerminalManagerEnforcesFourSessionLimit(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	t.Cleanup(manager.close)
	for index := 0; index < maxTerminalSessions; index++ {
		if _, err := manager.create("/", 80, 24); err != nil {
			t.Fatalf("create terminal %d: %v", index, err)
		}
	}
	if _, err := manager.create("/", 80, 24); err == nil || !strings.Contains(err.Error(), "four") {
		t.Fatalf("fifth terminal error = %v", err)
	}
}

func TestCreateTerminalRemovesSessionWhenRequestIsCancelled(t *testing.T) {
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	t.Cleanup(manager.close)
	server := &apiServer{terminals: manager}
	request := httptest.NewRequest(http.MethodPost, "/v1/terminals", strings.NewReader(`{"cwd":"/","columns":80,"rows":24}`))
	cancelledContext, cancel := context.WithCancel(request.Context())
	cancel()
	request = request.WithContext(cancelledContext)
	response := httptest.NewRecorder()

	server.handleCreateTerminal(response, request)

	if sessions := manager.list(); len(sessions) != 0 {
		t.Fatalf("cancelled request retained %d terminal sessions", len(sessions))
	}
}

func TestTerminalManagerRunsInteractiveShell(t *testing.T) {
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	t.Cleanup(manager.close)

	view, err := manager.create("/", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}

	const marker = "tengri-pty-ready-42"
	session.input([]byte("printf '" + marker + "\\n'\n"))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		session.mu.Lock()
		var output strings.Builder
		for _, chunk := range session.buffer {
			output.Write(chunk.data)
		}
		session.mu.Unlock()
		if strings.Contains(output.String(), marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("interactive PTY did not return shell output")
}

func TestTerminalManagerDrainsFinalOutputBeforeExit(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "burst-output.sh")
	content := "#!/bin/sh\nIFS= read -r ignored\ni=0\nwhile [ \"$i\" -lt 10000 ]; do printf 'output-%05d\\n' \"$i\"; i=$((i + 1)); done\nprintf 'tengri-final-output-marker\\n'\n"
	if err := os.WriteFile(script, []byte(content), 0o700); err != nil {
		t.Fatalf("write output fixture: %v", err)
	}
	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, script)
	t.Cleanup(manager.close)

	view, err := manager.create("/", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}
	session.input([]byte("start\r"))
	select {
	case <-session.outputDrained:
	case <-time.After(10 * time.Second):
		exited := false
		select {
		case <-session.processExited:
			exited = true
		default:
		}
		session.mu.Lock()
		var buffered strings.Builder
		for _, chunk := range session.buffer {
			buffered.Write(chunk.data)
		}
		session.mu.Unlock()
		output := buffered.String()
		if len(output) > 512 {
			output = output[len(output)-512:]
		}
		t.Fatalf("PTY output reader did not drain after shell exit (processExited=%t tail=%q)", exited, output)
	}

	session.mu.Lock()
	var output strings.Builder
	for _, chunk := range session.buffer {
		output.Write(chunk.data)
	}
	session.mu.Unlock()
	if !strings.Contains(output.String(), "tengri-final-output-marker") {
		t.Fatal("terminal replay buffer lost output written immediately before process exit")
	}
}

func TestTerminalManagerDefaultsToConfiguredWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	t.Cleanup(manager.close)

	view, err := manager.create("", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}
	if session.command.Dir != workspace.realRoot || view.Cwd != "/" {
		t.Fatalf("default terminal cwd = physical %q virtual %q", session.command.Dir, view.Cwd)
	}
}

func TestTerminalManagerCloseIsIdempotent(t *testing.T) {
	t.Parallel()
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	manager.close()
	manager.close()
}

func TestStaleTerminalDetachDoesNotRemoveReconnectedClient(t *testing.T) {
	t.Parallel()
	token := strings.Repeat("a", 24)
	previous := &terminalConnection{token: token}
	current := &terminalConnection{token: token}
	session := &terminalSession{connections: map[string]*terminalConnection{token: current}}

	session.detach(previous)
	if session.connections[token] != current {
		t.Fatal("stale detach removed the replacement terminal connection")
	}
	session.detach(current)
	if len(session.connections) != 0 {
		t.Fatal("current terminal connection was not detached")
	}
}

func TestTerminalReconnectReplacesDuplicateClientAndReplaysFromCursor(t *testing.T) {
	t.Parallel()
	token := strings.Repeat("a", 24)
	session := &terminalSession{
		id:          strings.Repeat("s", 24),
		sequence:    2,
		bufferBytes: 6,
		buffer: []terminalChunk{
			{sequence: 1, data: []byte("one")},
			{sequence: 2, data: []byte("two")},
		},
		connections: make(map[string]*terminalConnection),
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		since, _ := strconv.ParseUint(request.URL.Query().Get("since"), 10, 32)
		attached, err := session.attach(connection, request.URL.Query().Get("reconnect"), uint32(since))
		if err != nil {
			_ = connection.Close(websocket.StatusPolicyViolation, "attach failed")
			return
		}
		defer session.detach(attached)
		defer attached.close(websocket.StatusNormalClosure, "test complete")
		for {
			if _, _, err := connection.Read(request.Context()); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http")
	first, _, err := websocket.Dial(ctx, websocketURL+"?reconnect="+token, nil)
	if err != nil {
		t.Fatalf("dial first terminal client: %v", err)
	}
	defer first.CloseNow()
	assertTerminalReady(t, ctx, first, token)
	assertTerminalOutput(t, ctx, first, 1, "one")
	assertTerminalOutput(t, ctx, first, 2, "two")

	second, _, err := websocket.Dial(ctx, websocketURL+"?reconnect="+token+"&since=1", nil)
	if err != nil {
		t.Fatalf("dial replacement terminal client: %v", err)
	}
	defer second.CloseNow()
	assertTerminalReady(t, ctx, second, token)
	assertTerminalOutput(t, ctx, second, 2, "two")

	session.mu.Lock()
	connections := len(session.connections)
	session.mu.Unlock()
	if connections != 1 {
		t.Fatalf("terminal connections = %d, want one replacement", connections)
	}
	if _, _, err := first.Read(ctx); err == nil {
		t.Fatal("replaced terminal client remained connected")
	}
}

func TestTerminalReconnectResetsCursorOutsideReplayBuffer(t *testing.T) {
	t.Parallel()
	session := &terminalSession{
		id:             strings.Repeat("s", 24),
		sequence:       7,
		bufferBytes:    5,
		buffer:         []terminalChunk{{sequence: 7, data: []byte("fresh")}},
		connections:    make(map[string]*terminalConnection),
		lastActivityAt: time.Now().UTC(),
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		attached, err := session.attach(connection, request.URL.Query().Get("reconnect"), 3)
		if err != nil {
			_ = connection.Close(websocket.StatusPolicyViolation, "attach failed")
			return
		}
		defer session.detach(attached)
		defer attached.close(websocket.StatusNormalClosure, "test complete")
		for {
			if _, _, err := connection.Read(request.Context()); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token := strings.Repeat("b", 24)
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"?reconnect="+token, nil)
	if err != nil {
		t.Fatalf("dial terminal client: %v", err)
	}
	defer connection.CloseNow()
	assertTerminalReady(t, ctx, connection, token)
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read terminal reset: %v", err)
	}
	var reset struct {
		Type   string `json:"type"`
		Reason string `json:"reason"`
	}
	if messageType != websocket.MessageText || json.Unmarshal(payload, &reset) != nil ||
		reset.Type != "reset" || reset.Reason != "buffer_miss" {
		t.Fatalf("terminal reset = %s", payload)
	}
	assertTerminalOutput(t, ctx, connection, 7, "fresh")
}

func assertTerminalReady(t *testing.T, ctx context.Context, connection *websocket.Conn, token string) {
	t.Helper()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read terminal ready: %v", err)
	}
	var ready struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}
	if messageType != websocket.MessageText || json.Unmarshal(payload, &ready) != nil ||
		ready.Type != "ready" || ready.Token != token {
		t.Fatalf("terminal ready = %s", payload)
	}
}

func assertTerminalOutput(t *testing.T, ctx context.Context, connection *websocket.Conn, sequence uint32, output string) {
	t.Helper()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read terminal output: %v", err)
	}
	if messageType != websocket.MessageBinary || len(payload) < 5 || binary.BigEndian.Uint32(payload[1:5]) != sequence ||
		string(payload[5:]) != output {
		t.Fatalf("terminal output = type %d payload %v", messageType, payload)
	}
}

func TestTerminalReplayBufferBoundsBytesAndChunkCount(t *testing.T) {
	t.Parallel()
	session := &terminalSession{connections: make(map[string]*terminalConnection)}
	for index := 0; index < terminalBufferChunks+10; index++ {
		session.append([]byte("x"))
	}
	if len(session.buffer) != terminalBufferChunks {
		t.Fatalf("buffer chunks = %d, want %d", len(session.buffer), terminalBufferChunks)
	}

	session = &terminalSession{connections: make(map[string]*terminalConnection)}
	session.append(make([]byte, terminalBufferBytes+1))
	if len(session.buffer) != 1 || session.bufferBytes != terminalBufferBytes+1 {
		t.Fatalf("single oversized buffer = %d chunks, %d bytes", len(session.buffer), session.bufferBytes)
	}
	session.append([]byte("y"))
	if len(session.buffer) != 1 || session.bufferBytes != 1 {
		t.Fatalf("trimmed buffer = %d chunks, %d bytes", len(session.buffer), session.bufferBytes)
	}
}

func TestTerminalConnectionQueueRejectsSlowClient(t *testing.T) {
	t.Parallel()
	connection := &terminalConnection{
		connection: nil,
		done:       make(chan struct{}),
		outbound:   make(chan terminalDelivery, 1),
		token:      strings.Repeat("a", 24),
	}
	if !connection.enqueue(terminalMessage{messageType: websocket.MessageText, payload: []byte("first")}) {
		t.Fatal("first terminal delivery was rejected")
	}
	if connection.enqueue(terminalMessage{messageType: websocket.MessageText, payload: []byte("second")}) {
		t.Fatal("full terminal queue accepted another delivery")
	}
	if !connection.closed.Load() {
		t.Fatal("slow terminal connection was not marked closed")
	}
}

func TestTerminalReconnectTokensAreSecureAndValidated(t *testing.T) {
	t.Parallel()
	token, err := randomToken(24)
	if err != nil {
		t.Fatalf("randomToken() error = %v", err)
	}
	if len(token) != 24 || validateReconnectToken(token) != nil {
		t.Fatalf("generated reconnect token = %q", token)
	}
	for _, invalid := range []string{"short", strings.Repeat("a", 129), strings.Repeat("a", 23) + "!"} {
		if validateReconnectToken(invalid) == nil {
			t.Fatalf("validateReconnectToken(%q) succeeded", invalid)
		}
	}
}

func TestTerminalDimensionsAreBounded(t *testing.T) {
	t.Parallel()
	if got := clampTerminalDimension(0, 120, 20, 400); got != 120 {
		t.Fatalf("fallback dimension = %d", got)
	}
	if got := clampTerminalDimension(2, 120, 20, 400); got != 20 {
		t.Fatalf("minimum dimension = %d", got)
	}
	if got := clampTerminalDimension(500, 120, 20, 400); got != 400 {
		t.Fatalf("maximum dimension = %d", got)
	}
}

func TestTerminalResizeChangesPTYDimensions(t *testing.T) {
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, "/bin/sh")
	t.Cleanup(manager.close)
	view, err := manager.create("/", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}

	session.resize(177, 55)
	size, err := pty.GetsizeFull(session.terminal)
	if err != nil {
		t.Fatalf("read PTY dimensions: %v", err)
	}
	if size.Cols != 177 || size.Rows != 55 {
		t.Fatalf("PTY dimensions = %dx%d, want 177x55", size.Cols, size.Rows)
	}
}

func TestTerminalSignalsReachTheProcessGroup(t *testing.T) {
	directory := t.TempDir()
	shell := filepath.Join(directory, "signal-shell")
	script := "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatalf("write signal shell: %v", err)
	}
	workspace, err := newWorkspace(directory)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	manager := newTerminalManager(workspace, shell)
	t.Cleanup(manager.close)
	view, err := manager.create("/", 80, 24)
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	session, found := manager.get(view.ID)
	if !found {
		t.Fatal("created terminal session was not retained")
	}
	if err := session.signal("terminate"); err != nil {
		t.Fatalf("signal terminal: %v", err)
	}
	select {
	case <-session.processExited:
	case <-time.After(3 * time.Second):
		t.Fatal("terminal process did not exit after SIGTERM")
	}
	if _, err := terminalSignal("kill"); err == nil {
		t.Fatal("unsupported terminal signal was accepted")
	}
}
