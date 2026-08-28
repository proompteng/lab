package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

const (
	maxTerminalSessions  = 4
	maxTerminalClients   = 4
	terminalBufferBytes  = 4 << 20
	terminalBufferChunks = 8192
	terminalIdleTimeout  = 30 * time.Minute
	terminalCleanupDelay = 2 * time.Second
	terminalQueueDepth   = 128
	outputFrameType      = byte(1)
)

type terminalSessionView struct {
	ID             string    `json:"id"`
	CreationID     string    `json:"creationId"`
	Cwd            string    `json:"cwd"`
	CreatedAt      time.Time `json:"createdAt"`
	LastActivityAt time.Time `json:"lastActivityAt"`
	Attached       bool      `json:"attached"`
}

type createTerminalRequest struct {
	Columns    uint16 `json:"columns"`
	CreationID string `json:"creationId"`
	Cwd        string `json:"cwd"`
	Rows       uint16 `json:"rows"`
}

type terminalChunk struct {
	sequence uint32
	data     []byte
}

type terminalMessage struct {
	messageType websocket.MessageType
	payload     []byte
}

type terminalDelivery struct {
	messages   []terminalMessage
	closeAfter bool
	status     websocket.StatusCode
	reason     string
}

type terminalConnection struct {
	connection *websocket.Conn
	closed     atomic.Bool
	done       chan struct{}
	outbound   chan terminalDelivery
	token      string
}

func newTerminalConnection(connection *websocket.Conn, token string) *terminalConnection {
	result := &terminalConnection{
		connection: connection,
		done:       make(chan struct{}),
		outbound:   make(chan terminalDelivery, terminalQueueDepth),
		token:      token,
	}
	go result.writeLoop()
	return result
}

func (connection *terminalConnection) writeLoop() {
	for {
		select {
		case <-connection.done:
			return
		case delivery := <-connection.outbound:
			for _, message := range delivery.messages {
				if connection.closed.Load() {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := connection.connection.Write(ctx, message.messageType, message.payload)
				cancel()
				if err != nil {
					connection.abort()
					return
				}
			}
			if delivery.closeAfter {
				connection.close(delivery.status, delivery.reason)
				return
			}
		}
	}
}

func (connection *terminalConnection) enqueue(messages ...terminalMessage) bool {
	return connection.deliver(terminalDelivery{messages: messages})
}

func (connection *terminalConnection) closeAfter(status websocket.StatusCode, reason string, messages ...terminalMessage) bool {
	return connection.deliver(terminalDelivery{messages: messages, closeAfter: true, status: status, reason: reason})
}

func (connection *terminalConnection) deliver(delivery terminalDelivery) bool {
	if connection.closed.Load() {
		return false
	}
	select {
	case <-connection.done:
		return false
	case connection.outbound <- delivery:
		return true
	default:
		connection.close(websocket.StatusPolicyViolation, "Terminal client is too slow")
		return false
	}
}

func (connection *terminalConnection) close(status websocket.StatusCode, reason string) {
	if !connection.closed.CompareAndSwap(false, true) {
		return
	}
	close(connection.done)
	if connection.connection != nil {
		go func() { _ = connection.connection.Close(status, reason) }()
	}
}

func (connection *terminalConnection) abort() {
	if !connection.closed.CompareAndSwap(false, true) {
		return
	}
	close(connection.done)
	if connection.connection != nil {
		_ = connection.connection.CloseNow()
	}
}

type terminalSession struct {
	id               string
	creationID       string
	cwd              string
	createdAt        time.Time
	lastActivityAt   time.Time
	command          *exec.Cmd
	processSessionID int
	terminal         *os.File
	mu               sync.Mutex
	ioMu             sync.Mutex
	sequence         uint32
	bufferBytes      int
	buffer           []terminalChunk
	connections      map[string]*terminalConnection
	closed           bool
	processExited    chan struct{}
	outputDrained    chan struct{}
}

type terminalManager struct {
	workspace workspace
	shell     string
	home      string
	mu        sync.RWMutex
	sessions  map[string]*terminalSession
	stop      chan struct{}
	stopOnce  sync.Once
	closed    bool

	signalProcessSession func(int, syscall.Signal) error
	cleanupDelay         time.Duration
}

func newTerminalManager(workspace workspace, shell string, home string) *terminalManager {
	shell = resolveTerminalShell(shell)
	home = strings.TrimSpace(home)
	if home == "" {
		home = workspace.root
	}
	manager := &terminalManager{
		workspace:            workspace,
		shell:                shell,
		home:                 home,
		sessions:             make(map[string]*terminalSession),
		stop:                 make(chan struct{}),
		signalProcessSession: signalTerminalProcessSession,
		cleanupDelay:         terminalCleanupDelay,
	}
	go manager.reapIdle()
	return manager
}

func resolveTerminalShell(configured string) string {
	if shell := strings.TrimSpace(configured); shell != "" {
		if resolved, err := exec.LookPath(shell); err == nil {
			return resolved
		}
	}
	for _, candidate := range []string{"bash", "sh"} {
		if shell, err := exec.LookPath(candidate); err == nil {
			return shell
		}
	}
	return "/bin/sh"
}

func (manager *terminalManager) close() {
	manager.stopOnce.Do(func() {
		close(manager.stop)
		manager.mu.Lock()
		manager.closed = true
		sessions := make([]*terminalSession, 0, len(manager.sessions))
		for _, session := range manager.sessions {
			sessions = append(sessions, session)
		}
		manager.sessions = make(map[string]*terminalSession)
		manager.mu.Unlock()
		for _, session := range sessions {
			manager.terminateSession(session, "Nanoagent is shutting down")
		}
	})
}

func (manager *terminalManager) create(creationID, cwd string, columns, rows uint16) (terminalSessionView, bool, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return terminalSessionView{}, false, errors.New("terminal manager is closed")
	}
	if !validTerminalCreationID(creationID) {
		return terminalSessionView{}, false, errors.New("terminal creation ID is invalid")
	}
	for _, session := range manager.sessions {
		if session.creationID == creationID {
			return session.view(), false, nil
		}
	}
	if len(manager.sessions) >= maxTerminalSessions {
		return terminalSessionView{}, false, errors.New("at most four terminal sessions are allowed")
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = "/"
	}
	resolved, err := manager.workspace.resolveExisting(cwd)
	if err != nil {
		return terminalSessionView{}, false, err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return terminalSessionView{}, false, errors.New("terminal cwd must be a directory")
	}
	columns = clampTerminalDimension(columns, 120, 20, 400)
	rows = clampTerminalDimension(rows, 32, 6, 200)
	id, err := randomToken(24)
	if err != nil {
		return terminalSessionView{}, false, fmt.Errorf("generate terminal session ID: %w", err)
	}
	command := exec.Command(manager.shell, "-l", "-i")
	command.Dir = resolved
	command.Env = childEnvironment(
		"HOME="+manager.home,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TENGRI_TERMINAL_SESSION="+id,
	)
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: columns, Rows: rows})
	if err != nil {
		return terminalSessionView{}, false, err
	}
	now := time.Now().UTC()
	session := &terminalSession{
		id:               id,
		creationID:       creationID,
		cwd:              manager.workspace.displayPath(resolved),
		createdAt:        now,
		lastActivityAt:   now,
		command:          command,
		processSessionID: command.Process.Pid,
		terminal:         terminal,
		connections:      make(map[string]*terminalConnection),
		processExited:    make(chan struct{}),
		outputDrained:    make(chan struct{}),
	}
	manager.sessions[id] = session
	go manager.readOutput(session)
	go manager.waitForExit(session)
	return session.view(), true, nil
}

func (manager *terminalManager) list() []terminalSessionView {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	result := make([]terminalSessionView, 0, len(manager.sessions))
	for _, session := range manager.sessions {
		result = append(result, session.view())
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].CreatedAt.Before(result[right].CreatedAt) ||
			(result[left].CreatedAt.Equal(result[right].CreatedAt) && result[left].ID < result[right].ID)
	})
	return result
}

func (manager *terminalManager) get(id string) (*terminalSession, bool) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	session, found := manager.sessions[id]
	return session, found
}

func (manager *terminalManager) terminate(id string) bool {
	manager.mu.Lock()
	session, found := manager.sessions[id]
	if found {
		delete(manager.sessions, id)
	}
	manager.mu.Unlock()
	if found {
		manager.terminateSession(session, "Terminal session terminated")
	}
	return found
}

func (manager *terminalManager) terminateSession(session *terminalSession, reason string) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	connections := make([]*terminalConnection, 0, len(session.connections))
	for _, connection := range session.connections {
		connections = append(connections, connection)
	}
	session.connections = make(map[string]*terminalConnection)
	session.mu.Unlock()
	for _, connection := range connections {
		connection.close(websocket.StatusNormalClosure, reason)
	}
	manager.cleanupProcessSession(session)
	_ = session.terminal.Close()
}

func (manager *terminalManager) cleanupProcessSession(session *terminalSession) {
	sessionID := session.processSessionID
	if sessionID <= 0 && session.command != nil && session.command.Process != nil {
		sessionID = session.command.Process.Pid
	}
	if sessionID <= 0 {
		return
	}

	signalSession := manager.signalProcessSession
	if signalSession == nil {
		signalSession = signalTerminalProcessSession
	}
	if err := signalSession(sessionID, syscall.SIGTERM); err != nil && session.command != nil && session.command.Process != nil {
		_ = session.command.Process.Signal(syscall.SIGTERM)
	}

	delay := manager.cleanupDelay
	if delay <= 0 {
		delay = terminalCleanupDelay
	}
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		<-timer.C
		if err := signalSession(sessionID, syscall.SIGKILL); err != nil && session.command != nil && session.command.Process != nil {
			_ = session.command.Process.Kill()
		}
	}()
}

func (manager *terminalManager) readOutput(session *terminalSession) {
	defer close(session.outputDrained)
	buffer := make([]byte, 32<<10)
	for {
		read, err := session.terminal.Read(buffer)
		if read > 0 {
			payload := append([]byte(nil), buffer[:read]...)
			session.append(payload)
		}
		if err != nil {
			return
		}
	}
}

func (manager *terminalManager) waitForExit(session *terminalSession) {
	err := session.command.Wait()
	close(session.processExited)
	select {
	case <-session.outputDrained:
	case <-time.After(2 * time.Second):
		_ = session.terminal.Close()
		select {
		case <-session.outputDrained:
		case <-time.After(250 * time.Millisecond):
		}
	}
	exitCode := 0
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = -1
		}
	}
	payload, _ := json.Marshal(map[string]any{"type": "exit", "exitCode": exitCode})
	manager.finishExitedSession(session, payload)
}

func (manager *terminalManager) finishExitedSession(session *terminalSession, exitPayload []byte) {
	manager.mu.Lock()
	if manager.sessions[session.id] == session {
		delete(manager.sessions, session.id)
	}
	manager.mu.Unlock()

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		_ = session.terminal.Close()
		return
	}
	session.closed = true
	connections := make([]*terminalConnection, 0, len(session.connections))
	for _, connection := range session.connections {
		connections = append(connections, connection)
	}
	session.connections = make(map[string]*terminalConnection)
	session.mu.Unlock()
	manager.cleanupProcessSession(session)
	_ = session.terminal.Close()
	for _, connection := range connections {
		connection.closeAfter(
			websocket.StatusNormalClosure,
			"Terminal session exited",
			terminalMessage{messageType: websocket.MessageText, payload: exitPayload},
		)
	}
}

func (manager *terminalManager) remove(id string) {
	manager.mu.Lock()
	session, found := manager.sessions[id]
	if found {
		delete(manager.sessions, id)
	}
	manager.mu.Unlock()
	if found {
		manager.terminateSession(session, "Terminal session exited")
	}
}

func (manager *terminalManager) reapIdle() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-manager.stop:
			return
		case now := <-ticker.C:
			for _, session := range manager.listSessionsForReap() {
				session.mu.Lock()
				idle := len(session.connections) == 0 && now.Sub(session.lastActivityAt) >= terminalIdleTimeout
				session.mu.Unlock()
				if idle {
					manager.terminate(session.id)
				}
			}
		}
	}
}

func (manager *terminalManager) listSessionsForReap() []*terminalSession {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	result := make([]*terminalSession, 0, len(manager.sessions))
	for _, session := range manager.sessions {
		result = append(result, session)
	}
	return result
}

func (session *terminalSession) view() terminalSessionView {
	session.mu.Lock()
	defer session.mu.Unlock()
	return terminalSessionView{
		ID:             session.id,
		CreationID:     session.creationID,
		Cwd:            session.cwd,
		CreatedAt:      session.createdAt,
		LastActivityAt: session.lastActivityAt,
		Attached:       len(session.connections) > 0,
	}
}

func (session *terminalSession) append(payload []byte) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.sequence++
	chunk := terminalChunk{sequence: session.sequence, data: payload}
	session.buffer = append(session.buffer, chunk)
	session.bufferBytes += len(payload)
	for (session.bufferBytes > terminalBufferBytes || len(session.buffer) > terminalBufferChunks) &&
		len(session.buffer) > 1 {
		session.bufferBytes -= len(session.buffer[0].data)
		session.buffer = session.buffer[1:]
	}
	session.lastActivityAt = time.Now().UTC()
	connections := make([]*terminalConnection, 0, len(session.connections))
	for _, connection := range session.connections {
		connections = append(connections, connection)
	}
	session.mu.Unlock()
	frame := outputFrame(chunk)
	for _, connection := range connections {
		connection.enqueue(terminalMessage{messageType: websocket.MessageBinary, payload: frame})
	}
}

func (session *terminalSession) attach(connection *websocket.Conn, token string, since uint32) (*terminalConnection, error) {
	if err := validateReconnectToken(token); err != nil {
		return nil, err
	}
	if token == "" {
		generated, err := randomToken(24)
		if err != nil {
			return nil, fmt.Errorf("generate terminal reconnect token: %w", err)
		}
		token = generated
	}
	attached := newTerminalConnection(connection, token)
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		attached.close(websocket.StatusNormalClosure, "Terminal session is closed")
		return nil, errors.New("terminal session is closed")
	}
	previous := session.connections[token]
	if previous == nil && len(session.connections) >= maxTerminalClients {
		session.mu.Unlock()
		attached.close(websocket.StatusPolicyViolation, "Too many terminal clients")
		return nil, errors.New("at most four clients may attach to a terminal session")
	}
	session.connections[token] = attached
	session.lastActivityAt = time.Now().UTC()
	bufferStart := session.bufferStart()
	bufferEnd := session.sequence
	ready, _ := json.Marshal(map[string]any{
		"type":        "ready",
		"sessionId":   session.id,
		"token":       token,
		"bufferStart": bufferStart,
		"bufferEnd":   bufferEnd,
	})
	messages := []terminalMessage{{messageType: websocket.MessageText, payload: ready}}
	resetReason := terminalReplayResetReason(since, bufferStart, bufferEnd)
	if resetReason != "" {
		reset, _ := json.Marshal(map[string]any{
			"type":        "reset",
			"reason":      resetReason,
			"bufferStart": bufferStart,
			"bufferEnd":   bufferEnd,
		})
		messages = append(messages, terminalMessage{messageType: websocket.MessageText, payload: reset})
		since = 0
	}
	for _, chunk := range session.buffer {
		if chunk.sequence > since {
			messages = append(messages, terminalMessage{messageType: websocket.MessageBinary, payload: outputFrame(chunk)})
		}
	}
	if !attached.enqueue(messages...) {
		delete(session.connections, token)
		session.mu.Unlock()
		return nil, errors.New("terminal connection could not be initialized")
	}
	session.mu.Unlock()
	if previous != nil {
		previous.close(websocket.StatusNormalClosure, "Reconnected")
	}
	return attached, nil
}

func terminalReplayResetReason(since, bufferStart, bufferEnd uint32) string {
	if since > bufferEnd {
		return "invalid_cursor"
	}
	if since > 0 && since < bufferStart && bufferStart-since > 1 {
		return "buffer_miss"
	}
	return ""
}

func (session *terminalSession) detach(connection *terminalConnection) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.connections[connection.token] == connection {
		delete(session.connections, connection.token)
	}
}

func (session *terminalSession) bufferStart() uint32 {
	if len(session.buffer) == 0 {
		return session.sequence + 1
	}
	return session.buffer[0].sequence
}

func (session *terminalSession) input(payload []byte) {
	if len(payload) == 0 {
		return
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.lastActivityAt = time.Now().UTC()
	terminal := session.terminal
	session.mu.Unlock()
	session.ioMu.Lock()
	defer session.ioMu.Unlock()
	_, _ = terminal.Write(payload)
}

func (session *terminalSession) resize(columns, rows uint16) {
	columns = clampTerminalDimension(columns, 120, 20, 400)
	rows = clampTerminalDimension(rows, 32, 6, 200)
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	terminal := session.terminal
	session.mu.Unlock()
	session.ioMu.Lock()
	defer session.ioMu.Unlock()
	_ = pty.Setsize(terminal, &pty.Winsize{Cols: columns, Rows: rows})
}

func (session *terminalSession) signal(name string) error {
	signal, err := terminalSignal(name)
	if err != nil {
		return err
	}
	session.mu.Lock()
	if session.closed || session.command.Process == nil {
		session.mu.Unlock()
		return errors.New("terminal session is closed")
	}
	process := session.command.Process
	terminal := session.terminal
	session.lastActivityAt = time.Now().UTC()
	session.mu.Unlock()
	err = signalTerminalForeground(terminal, process.Pid, signal, terminalForegroundProcessGroup, syscall.Kill)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		if fallbackErr := process.Signal(signal); fallbackErr != nil {
			return fmt.Errorf("signal terminal process: %w", fallbackErr)
		}
	}
	return nil
}

func signalTerminalForeground(
	terminal *os.File,
	fallbackProcessGroup int,
	signal syscall.Signal,
	foregroundProcessGroup func(*os.File) (int, error),
	kill func(int, syscall.Signal) error,
) error {
	processGroup, err := foregroundProcessGroup(terminal)
	if err == nil {
		err = kill(-processGroup, signal)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	return kill(-fallbackProcessGroup, signal)
}

func terminalForegroundProcessGroup(terminal *os.File) (int, error) {
	processGroup, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil {
		return 0, fmt.Errorf("read terminal foreground process group: %w", err)
	}
	if processGroup <= 0 {
		return 0, errors.New("terminal has no foreground process group")
	}
	return processGroup, nil
}

func signalTerminalProcessSession(sessionID int, signal syscall.Signal) error {
	return signalProcessSession("/proc", sessionID, signal, syscall.Kill)
}

func signalProcessSession(
	procRoot string,
	sessionID int,
	signal syscall.Signal,
	kill func(int, syscall.Signal) error,
) error {
	processIDs, err := processIDsInSession(procRoot, sessionID)
	if err != nil || len(processIDs) == 0 {
		return kill(-sessionID, signal)
	}

	var firstError error
	for _, processID := range processIDs {
		if processID == sessionID {
			continue
		}
		if err := kill(processID, signal); err != nil && !errors.Is(err, syscall.ESRCH) && firstError == nil {
			firstError = err
		}
	}
	if err := kill(sessionID, signal); err != nil && !errors.Is(err, syscall.ESRCH) && firstError == nil {
		firstError = err
	}
	return firstError
}

func processIDsInSession(procRoot string, sessionID int) ([]int, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, err
	}
	processIDs := make([]int, 0)
	for _, entry := range entries {
		processID, err := strconv.Atoi(entry.Name())
		if err != nil || processID <= 0 {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(procRoot, entry.Name(), "stat"))
		if err != nil {
			continue
		}
		processSessionID, err := parseProcSessionID(contents)
		if err == nil && processSessionID == sessionID {
			processIDs = append(processIDs, processID)
		}
	}
	sort.Ints(processIDs)
	return processIDs, nil
}

func parseProcSessionID(contents []byte) (int, error) {
	closingParenthesis := strings.LastIndexByte(string(contents), ')')
	if closingParenthesis < 0 || closingParenthesis+1 >= len(contents) {
		return 0, errors.New("invalid proc stat command field")
	}
	fields := strings.Fields(string(contents[closingParenthesis+1:]))
	if len(fields) < 4 {
		return 0, errors.New("invalid proc stat process fields")
	}
	sessionID, err := strconv.Atoi(fields[3])
	if err != nil || sessionID <= 0 {
		return 0, errors.New("invalid proc stat session ID")
	}
	return sessionID, nil
}

func terminalSignal(name string) (syscall.Signal, error) {
	switch name {
	case "hangup":
		return syscall.SIGHUP, nil
	case "interrupt":
		return syscall.SIGINT, nil
	case "quit":
		return syscall.SIGQUIT, nil
	case "terminate":
		return syscall.SIGTERM, nil
	default:
		return 0, errors.New("unsupported terminal signal")
	}
}

func outputFrame(chunk terminalChunk) []byte {
	frame := make([]byte, 5+len(chunk.data))
	frame[0] = outputFrameType
	binary.BigEndian.PutUint32(frame[1:5], chunk.sequence)
	copy(frame[5:], chunk.data)
	return frame
}

func clampTerminalDimension(value, fallback, minimum, maximum uint16) uint16 {
	if value == 0 {
		value = fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func validTerminalCreationID(value string) bool {
	if len(value) < 16 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func (server *apiServer) handleCreateTerminal(writer http.ResponseWriter, request *http.Request) {
	var input createTerminalRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	session, created, err := server.terminals.create(input.CreationID, input.Cwd, input.Columns, input.Rows)
	if err != nil {
		if strings.Contains(err.Error(), "four terminal") {
			writeAPIError(writer, http.StatusConflict, err.Error())
		} else {
			writeWorkspaceError(writer, err)
		}
		return
	}
	if request.Context().Err() != nil {
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, session)
}

func (server *apiServer) handleListTerminals(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"sessions": server.terminals.list()})
}

func (server *apiServer) handleTerminateTerminal(writer http.ResponseWriter, request *http.Request) {
	if !server.terminals.terminate(request.PathValue("id")) {
		writeAPIError(writer, http.StatusNotFound, "terminal session was not found")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *apiServer) handleTerminalWebSocket(writer http.ResponseWriter, request *http.Request) {
	session, found := server.terminals.get(request.PathValue("id"))
	if !found {
		writeAPIError(writer, http.StatusNotFound, "terminal session was not found")
		return
	}
	connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	connection.SetReadLimit(1 << 20)
	since := uint64(0)
	if raw := request.URL.Query().Get("since"); raw != "" {
		since, _ = strconv.ParseUint(raw, 10, 32)
	}
	attached, err := session.attach(connection, request.URL.Query().Get("reconnect"), uint32(since))
	if err != nil {
		_ = connection.Close(websocket.StatusPolicyViolation, "Invalid terminal connection")
		return
	}
	defer session.detach(attached)
	defer attached.close(websocket.StatusNormalClosure, "Terminal disconnected")
	if columns, err := strconv.ParseUint(request.URL.Query().Get("cols"), 10, 16); err == nil {
		if rows, rowsErr := strconv.ParseUint(request.URL.Query().Get("rows"), 10, 16); rowsErr == nil {
			session.resize(uint16(columns), uint16(rows))
		}
	}
	for {
		messageType, payload, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		if messageType == websocket.MessageBinary {
			session.input(payload)
			continue
		}
		var control struct {
			Type    string `json:"type"`
			Columns uint16 `json:"cols"`
			Rows    uint16 `json:"rows"`
			Signal  string `json:"signal"`
		}
		if json.Unmarshal(payload, &control) != nil {
			continue
		}
		switch control.Type {
		case "resize":
			session.resize(control.Columns, control.Rows)
		case "ping":
			attached.enqueue(terminalMessage{messageType: websocket.MessageText, payload: []byte(`{"type":"pong"}`)})
		case "signal":
			if err := session.signal(control.Signal); err != nil {
				payload, _ := json.Marshal(map[string]string{"type": "error", "message": err.Error()})
				attached.enqueue(terminalMessage{messageType: websocket.MessageText, payload: payload})
			}
		case "terminate":
			server.terminals.terminate(session.id)
			return
		}
	}
}

func randomToken(length int) (string, error) {
	if length < 16 {
		return "", errors.New("secure token length must be at least 16 characters")
	}
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes)[:length], nil
}

func validateReconnectToken(token string) error {
	if token == "" {
		return nil
	}
	if len(token) < 16 || len(token) > 128 {
		return errors.New("terminal reconnect token has an invalid length")
	}
	for _, character := range token {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return errors.New("terminal reconnect token contains invalid characters")
	}
	return nil
}
