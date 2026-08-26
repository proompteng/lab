package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	codexEventBufferSize  = 2_048
	codexEventBufferBytes = 16 << 20
	codexEventMaxBytes    = 2 << 20
	codexSubscriberLimit  = 8
)

type codexCallRequest struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type codexCallResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

type codexApprovalRequest struct {
	Decision string `json:"decision"`
}

type codexEvent struct {
	Sequence   uint64          `json:"sequence"`
	Method     string          `json:"method"`
	ApprovalID string          `json:"approvalId,omitempty"`
	Raw        json.RawMessage `json:"raw"`
}

type codexRPCMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

type codexPendingResult struct {
	result json.RawMessage
	err    json.RawMessage
}

type codexSubscription struct {
	channel chan codexEvent
}

type codexApproval struct {
	method      string
	permissions json.RawMessage
	rawID       json.RawMessage
	resolving   bool
}

type codexSupervisor struct {
	binary    string
	cwd       string
	closed    atomic.Bool
	requestID atomic.Uint64

	mu             sync.Mutex
	command        *exec.Cmd
	stdin          io.WriteCloser
	ready          chan struct{}
	pending        map[string]chan codexPendingResult
	approvals      map[string]codexApproval
	sequence       uint64
	buffer         []codexEvent
	bufferBytes    int
	subscriptions  map[uint64]codexSubscription
	nextSubscriber uint64
	shutdown       chan struct{}
}

func newCodexSupervisor(binary, cwd string) *codexSupervisor {
	return &codexSupervisor{
		binary:        binary,
		cwd:           cwd,
		ready:         make(chan struct{}),
		pending:       make(map[string]chan codexPendingResult),
		approvals:     make(map[string]codexApproval),
		subscriptions: make(map[uint64]codexSubscription),
		shutdown:      make(chan struct{}),
	}
}

func (supervisor *codexSupervisor) start() {
	go supervisor.run()
}

func (supervisor *codexSupervisor) isReady() bool {
	supervisor.mu.Lock()
	ready := supervisor.ready
	supervisor.mu.Unlock()
	select {
	case <-ready:
		return true
	default:
		return false
	}
}

func (supervisor *codexSupervisor) run() {
	backoff := time.Second
	for !supervisor.closed.Load() {
		if err := supervisor.runProcess(); err != nil && !supervisor.closed.Load() {
			supervisor.publish("error", "", map[string]any{
				"method": "error",
				"params": map[string]string{"message": "Codex app-server is restarting"},
			})
		}
		if supervisor.closed.Load() {
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-supervisor.shutdown:
			timer.Stop()
			return
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (supervisor *codexSupervisor) runProcess() error {
	command := exec.Command(
		supervisor.binary,
		"--sandbox", "danger-full-access",
		"--ask-for-approval", "on-request",
		"app-server",
	)
	command.Dir = supervisor.cwd
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return err
	}

	supervisor.mu.Lock()
	supervisor.command = command
	supervisor.stdin = stdin
	supervisor.mu.Unlock()
	go supervisor.readMessages(command, stdout)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	initialize, err := json.Marshal(map[string]any{
		"clientInfo": map[string]string{
			"name":    "tengri",
			"title":   "Tengri MicroVM Desktop",
			"version": "0.1.0",
		},
		"capabilities": map[string]any{
			"experimentalApi":    true,
			"requestAttestation": false,
		},
	})
	if err == nil {
		_, err = supervisor.request(ctx, "initialize", initialize, false)
	}
	cancel()
	if err != nil {
		killProcessGroup(command)
		_ = command.Wait()
		supervisor.failProcess(err)
		return fmt.Errorf("initialize Codex app-server: %w", err)
	}
	if err := supervisor.writeMessage(map[string]any{"method": "initialized"}); err != nil {
		killProcessGroup(command)
		_ = command.Wait()
		supervisor.failProcess(err)
		return fmt.Errorf("acknowledge Codex app-server initialization: %w", err)
	}
	supervisor.mu.Lock()
	close(supervisor.ready)
	supervisor.mu.Unlock()
	waitErr := command.Wait()
	processErr := errors.New("Codex app-server exited")
	if waitErr != nil {
		processErr = fmt.Errorf("Codex app-server exited: %w", waitErr)
	}
	supervisor.failProcess(processErr)
	return processErr
}

func (supervisor *codexSupervisor) close() {
	if supervisor.closed.Swap(true) {
		return
	}
	close(supervisor.shutdown)
	supervisor.mu.Lock()
	command := supervisor.command
	pending := supervisor.pending
	supervisor.pending = make(map[string]chan codexPendingResult)
	for id, subscription := range supervisor.subscriptions {
		delete(supervisor.subscriptions, id)
		close(subscription.channel)
	}
	supervisor.approvals = make(map[string]codexApproval)
	supervisor.mu.Unlock()
	shutdownError, _ := json.Marshal(map[string]string{"message": "Codex app-server is shutting down"})
	for _, response := range pending {
		response <- codexPendingResult{err: shutdownError}
	}
	if command != nil && command.Process != nil {
		killProcessGroup(command)
	}
}

func killProcessGroup(command *exec.Cmd) {
	if command == nil || command.Process == nil || command.Process.Pid <= 0 {
		return
	}
	if err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL); err != nil {
		_ = command.Process.Kill()
	}
}

func (supervisor *codexSupervisor) call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	if !allowedCodexMethod(method) {
		return nil, errors.New("Codex method is not exposed by Nanoagent")
	}
	return supervisor.request(ctx, method, params, true)
}

func (supervisor *codexSupervisor) request(
	ctx context.Context,
	method string,
	params json.RawMessage,
	waitReady bool,
) (json.RawMessage, error) {
	if waitReady {
		supervisor.mu.Lock()
		ready := supervisor.ready
		supervisor.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ready:
		}
	}
	id := supervisor.requestID.Add(1)
	key := fmt.Sprintf("%d", id)
	response := make(chan codexPendingResult, 1)
	supervisor.mu.Lock()
	supervisor.pending[key] = response
	stdin := supervisor.stdin
	supervisor.mu.Unlock()
	if stdin == nil {
		supervisor.removePending(key)
		return nil, errors.New("Codex app-server is unavailable")
	}
	message, err := json.Marshal(map[string]any{"id": id, "method": method, "params": json.RawMessage(params)})
	if err != nil {
		supervisor.removePending(key)
		return nil, err
	}
	supervisor.mu.Lock()
	_, err = stdin.Write(append(message, '\n'))
	supervisor.mu.Unlock()
	if err != nil {
		supervisor.removePending(key)
		return nil, err
	}
	select {
	case <-ctx.Done():
		supervisor.removePending(key)
		return nil, ctx.Err()
	case result := <-response:
		if len(result.err) > 0 && string(result.err) != "null" {
			return nil, fmt.Errorf("Codex app-server request failed: %s", compactJSON(result.err))
		}
		return result.result, nil
	}
}

func (supervisor *codexSupervisor) readMessages(command *exec.Cmd, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var message codexRPCMessage
		if json.Unmarshal(line, &message) != nil {
			continue
		}
		if len(message.ID) > 0 && message.Method == "" {
			supervisor.resolveResponse(message)
			continue
		}
		if message.Method != "" {
			supervisor.handleServerMessage(message, line)
		}
	}
	killProcessGroup(command)
}

func (supervisor *codexSupervisor) resolveResponse(message codexRPCMessage) {
	key := normalizeRequestID(message.ID)
	supervisor.mu.Lock()
	pending := supervisor.pending[key]
	delete(supervisor.pending, key)
	supervisor.mu.Unlock()
	if pending != nil {
		pending <- codexPendingResult{result: message.Result, err: message.Error}
	}
}

func (supervisor *codexSupervisor) handleServerMessage(message codexRPCMessage, raw []byte) {
	approvalID := ""
	if len(message.ID) > 0 {
		approvalID = normalizeRequestID(message.ID)
		switch message.Method {
		case "currentTime/read":
			_ = supervisor.respondRaw(message.ID, map[string]any{"currentTimeAt": time.Now().Unix()})
			return
		case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval":
			supervisor.mu.Lock()
			supervisor.approvals[approvalID] = codexApproval{
				method: message.Method,
				rawID:  append(json.RawMessage(nil), message.ID...),
			}
			supervisor.mu.Unlock()
		case "item/permissions/requestApproval":
			var params struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			if json.Unmarshal(message.Params, &params) != nil || len(params.Permissions) == 0 {
				supervisor.respondError(message.ID, "permission request did not include a valid permission profile")
				return
			}
			supervisor.mu.Lock()
			supervisor.approvals[approvalID] = codexApproval{
				method:      message.Method,
				permissions: append(json.RawMessage(nil), params.Permissions...),
				rawID:       append(json.RawMessage(nil), message.ID...),
			}
			supervisor.mu.Unlock()
		default:
			supervisor.respondError(message.ID, "Tengri does not expose this app-server client request")
			return
		}
	}
	supervisor.publish(message.Method, approvalID, json.RawMessage(raw))
}

func (supervisor *codexSupervisor) resolveApproval(id, decision string) error {
	supervisor.mu.Lock()
	approval, found := supervisor.approvals[id]
	if found && approval.resolving {
		supervisor.mu.Unlock()
		return errors.New("Codex approval is already being resolved")
	}
	if found {
		approval.resolving = true
		supervisor.approvals[id] = approval
	}
	supervisor.mu.Unlock()
	if !found {
		return errors.New("Codex approval was not found or was already resolved")
	}
	result, err := codexApprovalResult(approval, decision)
	if err != nil {
		supervisor.resetApproval(id, approval)
		return err
	}
	if err := supervisor.respondRaw(approval.rawID, result); err != nil {
		supervisor.resetApproval(id, approval)
		return err
	}
	supervisor.mu.Lock()
	delete(supervisor.approvals, id)
	supervisor.mu.Unlock()
	return nil
}

func codexApprovalResult(approval codexApproval, decision string) (map[string]any, error) {
	protocolDecision := map[string]string{
		"approveOnce":    "accept",
		"approveSession": "acceptForSession",
		"deny":           "decline",
	}[decision]
	if protocolDecision == "" {
		return nil, errors.New("invalid approval decision")
	}
	if approval.method == "item/permissions/requestApproval" {
		permissions := json.RawMessage(`{}`)
		if protocolDecision != "decline" {
			permissions = approval.permissions
		}
		scope := "turn"
		if protocolDecision == "acceptForSession" {
			scope = "session"
		}
		return map[string]any{"permissions": permissions, "scope": scope}, nil
	}
	result := map[string]any{"decision": protocolDecision}
	if approval.method == "item/commandExecution/requestApproval" {
		result["acceptSettings"] = nil
	}
	if approval.method == "execCommandApproval" || approval.method == "applyPatchApproval" {
		if protocolDecision == "accept" {
			result["decision"] = "approved"
		} else if protocolDecision == "acceptForSession" {
			result["decision"] = "approved_for_session"
		} else {
			result["decision"] = "denied"
		}
	}
	return result, nil
}

func (supervisor *codexSupervisor) resetApproval(id string, approval codexApproval) {
	supervisor.mu.Lock()
	if current, found := supervisor.approvals[id]; found && current.resolving {
		approval.resolving = false
		supervisor.approvals[id] = approval
	}
	supervisor.mu.Unlock()
}

func (supervisor *codexSupervisor) respondRaw(id json.RawMessage, result any) error {
	return supervisor.writeMessage(map[string]any{"id": json.RawMessage(id), "result": result})
}

func (supervisor *codexSupervisor) respondError(id json.RawMessage, message string) {
	supervisor.writeMessage(map[string]any{
		"id":    json.RawMessage(id),
		"error": map[string]any{"code": -32_000, "message": message},
	})
}

func (supervisor *codexSupervisor) writeMessage(value any) error {
	message, err := json.Marshal(value)
	if err != nil {
		return err
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.stdin == nil {
		return errors.New("Codex app-server is unavailable")
	}
	_, err = supervisor.stdin.Write(append(message, '\n'))
	return err
}

func (supervisor *codexSupervisor) publish(method, approvalID string, value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	if direct, ok := value.(json.RawMessage); ok {
		raw = append([]byte(nil), direct...)
	}
	if len(raw) > codexEventMaxBytes {
		raw = codexOversizedEvent(method, len(raw))
		method = "tengri/eventOmitted"
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	supervisor.sequence++
	event := codexEvent{Sequence: supervisor.sequence, Method: method, ApprovalID: approvalID, Raw: raw}
	supervisor.buffer = append(supervisor.buffer, event)
	supervisor.bufferBytes += len(raw)
	for len(supervisor.buffer) > codexEventBufferSize || supervisor.bufferBytes > codexEventBufferBytes {
		supervisor.bufferBytes -= len(supervisor.buffer[0].Raw)
		supervisor.buffer = supervisor.buffer[1:]
	}
	for id, subscription := range supervisor.subscriptions {
		select {
		case subscription.channel <- event:
		default:
			delete(supervisor.subscriptions, id)
			close(subscription.channel)
		}
	}
}

func (supervisor *codexSupervisor) subscribe(after uint64) (uint64, <-chan codexEvent, error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed.Load() {
		return 0, nil, errors.New("Codex event service is shutting down")
	}
	if len(supervisor.subscriptions) >= codexSubscriberLimit {
		return 0, nil, errors.New("too many Codex event subscribers")
	}
	supervisor.nextSubscriber++
	id := supervisor.nextSubscriber
	replay := make([]codexEvent, 0, len(supervisor.buffer)+1)
	bufferStart := uint64(0)
	bufferEnd := supervisor.sequence
	if len(supervisor.buffer) > 0 {
		bufferStart = supervisor.buffer[0].Sequence
		bufferEnd = supervisor.buffer[len(supervisor.buffer)-1].Sequence
	}
	replayStart := sequenceBefore(bufferStart)
	if after > supervisor.sequence || (len(supervisor.buffer) > 0 && after > 0 && after < replayStart) {
		replay = append(replay, codexReplayWarning(bufferStart, bufferEnd))
		after = 0
	}
	for _, event := range supervisor.buffer {
		if event.Sequence > after {
			replay = append(replay, event)
		}
	}
	channel := make(chan codexEvent, len(replay)+256)
	for _, event := range replay {
		channel <- event
	}
	supervisor.subscriptions[id] = codexSubscription{channel: channel}
	return id, channel, nil
}

func codexOversizedEvent(method string, size int) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"method": "tengri/eventOmitted",
		"params": map[string]any{
			"message":        "Codex event exceeded the bounded desktop replay limit and was omitted",
			"originalMethod": method,
			"bytes":          size,
		},
	})
	return raw
}

func codexReplayWarning(bufferStart, bufferEnd uint64) codexEvent {
	raw, _ := json.Marshal(map[string]any{
		"method": "tengri/replayWarning",
		"params": map[string]any{
			"message":     "Codex event replay window expired; thread state must be refreshed",
			"bufferStart": bufferStart,
			"bufferEnd":   bufferEnd,
		},
	})
	return codexEvent{
		Sequence: sequenceBefore(bufferStart),
		Method:   "tengri/replayWarning",
		Raw:      raw,
	}
}

func sequenceBefore(sequence uint64) uint64 {
	if sequence == 0 {
		return 0
	}

	return sequence - 1
}

func (supervisor *codexSupervisor) unsubscribe(id uint64) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if subscription, found := supervisor.subscriptions[id]; found {
		delete(supervisor.subscriptions, id)
		close(subscription.channel)
	}
}

func (supervisor *codexSupervisor) removePending(id string) {
	supervisor.mu.Lock()
	delete(supervisor.pending, id)
	supervisor.mu.Unlock()
}

func (supervisor *codexSupervisor) failProcess(err error) {
	supervisor.mu.Lock()
	supervisor.command = nil
	supervisor.stdin = nil
	supervisor.ready = make(chan struct{})
	pending := supervisor.pending
	supervisor.pending = make(map[string]chan codexPendingResult)
	supervisor.approvals = make(map[string]codexApproval)
	supervisor.mu.Unlock()
	encoded, _ := json.Marshal(map[string]string{"message": err.Error()})
	for _, channel := range pending {
		channel <- codexPendingResult{err: encoded}
	}
}

func normalizeRequestID(id json.RawMessage) string {
	return strings.Trim(string(id), "\"")
}

func compactJSON(value json.RawMessage) string {
	var buffer bytes.Buffer
	if json.Compact(&buffer, value) == nil {
		return buffer.String()
	}
	return "request failed"
}

func allowedCodexMethod(method string) bool {
	switch method {
	case "account/read", "account/login/start", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt":
		return true
	default:
		return false
	}
}

func (server *apiServer) handleCodexCall(writer http.ResponseWriter, request *http.Request) {
	if server.codex == nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "Codex app-server is disabled")
		return
	}
	var input codexCallRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	result, err := server.codex.call(request.Context(), input.Method, input.Params)
	if err != nil {
		writeAPIError(writer, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, codexCallResponse{Result: result})
}

func (server *apiServer) handleCodexApproval(writer http.ResponseWriter, request *http.Request) {
	if server.codex == nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "Codex app-server is disabled")
		return
	}
	var input codexApprovalRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	if err := server.codex.resolveApproval(request.PathValue("id"), input.Decision); err != nil {
		writeAPIError(writer, http.StatusNotFound, err.Error())
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *apiServer) handleCodexEvents(writer http.ResponseWriter, request *http.Request) {
	if server.codex == nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "Codex app-server is disabled")
		return
	}
	after := uint64(0)
	if raw := request.URL.Query().Get("after"); raw != "" {
		parsed, err := parseBoundedUint(raw)
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, "after must be an unsigned sequence")
			return
		}
		after = parsed
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeAPIError(writer, http.StatusInternalServerError, "streaming is unavailable")
		return
	}
	id, events, err := server.codex.subscribe(after)
	if err != nil {
		writeAPIError(writer, http.StatusTooManyRequests, err.Error())
		return
	}
	defer server.codex.unsubscribe(id)
	writer.Header().Set("Content-Type", "application/x-ndjson")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	flusher.Flush()
	encoder := json.NewEncoder(writer)
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open || encoder.Encode(event) != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func parseBoundedUint(value string) (uint64, error) {
	return strconv.ParseUint(value, 10, 64)
}
