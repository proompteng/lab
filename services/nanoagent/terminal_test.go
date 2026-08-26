package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
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
