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
	codexEventBufferSize      = 2_048
	codexEventBufferBytes     = 16 << 20
	codexEventMaxBytes        = 2 << 20
	codexProtocolLineMaxBytes = 8 << 20
	codexSubscriberLimit      = 8
	codexApprovalWriteTimeout = 15 * time.Second
	codexResponseWriteTimeout = 15 * time.Second
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
	generation  *codexProcessGeneration
	method      string
	permissions json.RawMessage
	decisions   map[string]json.RawMessage
	rawID       json.RawMessage
	resolving   bool
}

type codexProcessGeneration struct {
	ready   chan struct{}
	failure error
}

type codexSupervisor struct {
	binary          string
	cwd             string
	closed          atomic.Bool
	requestID       atomic.Uint64
	writePermit     chan struct{}
	loginMu         sync.Mutex
	responseTimeout time.Duration

	mu             sync.Mutex
	command        *exec.Cmd
	stdin          io.WriteCloser
	generation     *codexProcessGeneration
	pending        map[string]chan codexPendingResult
	approvals      map[string]codexApproval
	activeLoginID  string
	sequence       uint64
	buffer         []codexEvent
	bufferBytes    int
	subscriptions  map[uint64]codexSubscription
	nextSubscriber uint64
	shutdown       chan struct{}
}

func newCodexSupervisor(binary, cwd string) *codexSupervisor {
	supervisor := &codexSupervisor{
		binary:          binary,
		cwd:             cwd,
		writePermit:     make(chan struct{}, 1),
		responseTimeout: codexResponseWriteTimeout,
		generation:      newCodexProcessGeneration(),
		pending:         make(map[string]chan codexPendingResult),
		approvals:       make(map[string]codexApproval),
		subscriptions:   make(map[uint64]codexSubscription),
		shutdown:        make(chan struct{}),
	}
	supervisor.writePermit <- struct{}{}
	return supervisor
}

func newCodexProcessGeneration() *codexProcessGeneration {
	return &codexProcessGeneration{ready: make(chan struct{})}
}

func (supervisor *codexSupervisor) start() {
	go supervisor.run()
}

func (supervisor *codexSupervisor) isReady() bool {
	if supervisor.closed.Load() {
		return false
	}
	supervisor.mu.Lock()
	generation := supervisor.generation
	supervisor.mu.Unlock()
	select {
	case <-generation.ready:
		supervisor.mu.Lock()
		ready := supervisor.generation == generation && generation.failure == nil && supervisor.stdin != nil
		supervisor.mu.Unlock()
		return ready && !supervisor.closed.Load()
	default:
		return false
	}
}

func (supervisor *codexSupervisor) run() {
	backoff := time.Second
	for !supervisor.closed.Load() {
		if err := supervisor.runProcess(); err != nil && !supervisor.closed.Load() {
			supervisor.failProcess(err)
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
	command.Env = childEnvironment()
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
	generation := supervisor.generation
	supervisor.mu.Unlock()
	go supervisor.readMessages(command, generation, stdout)

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
		return fmt.Errorf("initialize Codex app-server: %w", err)
	}
	if err := supervisor.writeMessage(map[string]any{"method": "initialized"}); err != nil {
		killProcessGroup(command)
		_ = command.Wait()
		return fmt.Errorf("acknowledge Codex app-server initialization: %w", err)
	}
	supervisor.mu.Lock()
	closeSignal(generation.ready)
	supervisor.mu.Unlock()
	waitErr := command.Wait()
	processErr := errors.New("Codex app-server exited")
	if waitErr != nil {
		processErr = fmt.Errorf("Codex app-server exited: %w", waitErr)
	}
	return processErr
}

func (supervisor *codexSupervisor) close() {
	if supervisor.closed.Swap(true) {
		return
	}
	close(supervisor.shutdown)
	supervisor.mu.Lock()
	command := supervisor.command
	supervisor.generation.failure = errors.New("Codex app-server is shutting down")
	closeSignal(supervisor.generation.ready)
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
	if method == "account/login/start" {
		return supervisor.startLogin(ctx, params)
	}
	return supervisor.request(ctx, method, params, true)
}

func (supervisor *codexSupervisor) startLogin(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	supervisor.loginMu.Lock()
	defer supervisor.loginMu.Unlock()

	supervisor.mu.Lock()
	previousLoginID := supervisor.activeLoginID
	supervisor.mu.Unlock()
	if previousLoginID != "" {
		cancelParams, _ := json.Marshal(map[string]string{"loginId": previousLoginID})
		cancelContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, cancelErr := supervisor.request(cancelContext, "account/login/cancel", cancelParams, true)
		cancel()
		if cancelErr != nil {
			return nil, fmt.Errorf("cancel previous Codex device login: %w", cancelErr)
		}
		supervisor.mu.Lock()
		if supervisor.activeLoginID == previousLoginID {
			supervisor.activeLoginID = ""
		}
		supervisor.mu.Unlock()
	}
	result, err := supervisor.request(ctx, "account/login/start", params, true)
	if err != nil {
		return nil, err
	}
	var login struct {
		LoginID string `json:"loginId"`
	}
	if json.Unmarshal(result, &login) != nil || login.LoginID == "" || len(login.LoginID) > 160 {
		return nil, errors.New("Codex app-server returned an invalid device login")
	}
	supervisor.mu.Lock()
	supervisor.activeLoginID = login.LoginID
	supervisor.mu.Unlock()
	return result, nil
}

func (supervisor *codexSupervisor) request(
	ctx context.Context,
	method string,
	params json.RawMessage,
	waitReady bool,
) (json.RawMessage, error) {
	var generation *codexProcessGeneration
	if waitReady {
		supervisor.mu.Lock()
		generation = supervisor.generation
		supervisor.mu.Unlock()
		if err := supervisor.waitForGeneration(ctx, generation); err != nil {
			return nil, err
		}
	}
	id := supervisor.requestID.Add(1)
	key := fmt.Sprintf("%d", id)
	response := make(chan codexPendingResult, 1)
	supervisor.mu.Lock()
	if generation == nil {
		generation = supervisor.generation
	}
	if waitReady && (supervisor.generation != generation || generation.failure != nil) {
		supervisor.mu.Unlock()
		return nil, errors.New("Codex app-server restarted before the request could be sent")
	}
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
	err = supervisor.writeToProcess(ctx, generation, stdin, append(message, '\n'))
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

func (supervisor *codexSupervisor) waitForGeneration(
	ctx context.Context,
	generation *codexProcessGeneration,
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-supervisor.shutdown:
		return errors.New("Codex app-server is shutting down")
	case <-generation.ready:
		supervisor.mu.Lock()
		failure := generation.failure
		supervisor.mu.Unlock()
		if failure != nil {
			return fmt.Errorf("Codex app-server generation failed: %w", failure)
		}
		return nil
	}
}

func (supervisor *codexSupervisor) readMessages(
	command *exec.Cmd,
	generation *codexProcessGeneration,
	reader io.Reader,
) {
	supervisor.readMessagesWithLimit(command, generation, reader, codexProtocolLineMaxBytes)
}

func (supervisor *codexSupervisor) readMessagesWithLimit(
	command *exec.Cmd,
	generation *codexProcessGeneration,
	reader io.Reader,
	lineLimit int,
) {
	buffered := bufio.NewReaderSize(reader, 64<<10)
	for {
		line, size, oversized, readErr := readBoundedCodexLine(buffered, lineLimit)
		if oversized {
			supervisor.publish("tengri/eventOmitted", "", codexOversizedProtocolMessage(size))
		} else if len(bytes.TrimSpace(line)) > 0 {
			var message codexRPCMessage
			if json.Unmarshal(line, &message) == nil {
				if len(message.ID) > 0 && message.Method == "" {
					supervisor.resolveResponse(message)
				} else if message.Method != "" {
					supervisor.handleServerMessage(generation, message, line)
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	killProcessGroup(command)
}

func readBoundedCodexLine(reader *bufio.Reader, limit int) ([]byte, int, bool, error) {
	if limit <= 0 {
		return nil, 0, false, errors.New("Codex protocol line limit must be positive")
	}
	line := make([]byte, 0, min(limit, reader.Size()))
	size := 0
	oversized := false
	for {
		fragment, err := reader.ReadSlice('\n')
		size += len(fragment)
		if !oversized {
			if len(line)+len(fragment) > limit {
				line = nil
				oversized = true
			} else {
				line = append(line, fragment...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		return line, size, oversized, err
	}
}

func codexOversizedProtocolMessage(size int) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"method": "tengri/eventOmitted",
		"params": map[string]any{
			"message": "Codex protocol message exceeded the bounded input limit and was omitted",
			"bytes":   size,
		},
	})
	return raw
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

func (supervisor *codexSupervisor) handleServerMessage(
	generation *codexProcessGeneration,
	message codexRPCMessage,
	raw []byte,
) {
	if !supervisor.isCurrentGeneration(generation) {
		return
	}
	if message.Method == "account/login/completed" {
		var params struct {
			LoginID string `json:"loginId"`
		}
		if json.Unmarshal(message.Params, &params) == nil {
			supervisor.mu.Lock()
			if supervisor.generation == generation && (params.LoginID == "" || supervisor.activeLoginID == params.LoginID) {
				supervisor.activeLoginID = ""
			}
			supervisor.mu.Unlock()
		}
	}
	approvalID := ""
	if len(message.ID) > 0 {
		approvalID = normalizeRequestID(message.ID)
		switch message.Method {
		case "currentTime/read":
			_ = supervisor.respondRawForGenerationWithin(
				generation,
				message.ID,
				map[string]any{"currentTimeAt": time.Now().Unix()},
			)
			return
		case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval":
			supervisor.mu.Lock()
			if supervisor.generation != generation || generation.failure != nil {
				supervisor.mu.Unlock()
				return
			}
			supervisor.approvals[approvalID] = codexApproval{
				generation: generation,
				method:     message.Method,
				decisions:  codexApprovalDecisions(message.Method, message.Params),
				rawID:      append(json.RawMessage(nil), message.ID...),
			}
			supervisor.mu.Unlock()
		case "item/permissions/requestApproval":
			var params struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			if json.Unmarshal(message.Params, &params) != nil || len(params.Permissions) == 0 {
				supervisor.respondErrorForGeneration(
					generation,
					message.ID,
					"permission request did not include a valid permission profile",
				)
				return
			}
			supervisor.mu.Lock()
			if supervisor.generation != generation || generation.failure != nil {
				supervisor.mu.Unlock()
				return
			}
			supervisor.approvals[approvalID] = codexApproval{
				generation:  generation,
				method:      message.Method,
				permissions: append(json.RawMessage(nil), params.Permissions...),
				decisions:   defaultCodexApprovalDecisions(),
				rawID:       append(json.RawMessage(nil), message.ID...),
			}
			supervisor.mu.Unlock()
		default:
			supervisor.respondErrorForGeneration(
				generation,
				message.ID,
				"Tengri does not expose this app-server client request",
			)
			return
		}
	}
	if !supervisor.isCurrentGeneration(generation) {
		return
	}
	supervisor.publish(message.Method, approvalID, json.RawMessage(raw))
}

func (supervisor *codexSupervisor) isCurrentGeneration(generation *codexProcessGeneration) bool {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return generation != nil && supervisor.generation == generation && generation.failure == nil
}

func (supervisor *codexSupervisor) resolveApproval(ctx context.Context, id, decision string) error {
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
	writeContext, cancel := context.WithTimeout(ctx, codexApprovalWriteTimeout)
	defer cancel()
	if err := supervisor.respondRawForGeneration(writeContext, approval.generation, approval.rawID, result); err != nil {
		supervisor.resetApproval(id, approval)
		return err
	}
	supervisor.finishApproval(id, approval)
	return nil
}

func codexApprovalResult(approval codexApproval, decision string) (map[string]any, error) {
	encodedDecision := approval.decisions[decision]
	if approval.decisions == nil {
		encodedDecision = defaultCodexApprovalDecisions()[decision]
	}
	if len(encodedDecision) == 0 {
		return nil, errors.New("approval decision is not available")
	}
	var protocolDecision any
	if err := json.Unmarshal(encodedDecision, &protocolDecision); err != nil {
		return nil, fmt.Errorf("decode approval decision: %w", err)
	}
	protocolName, _ := protocolDecision.(string)
	if approval.method == "item/permissions/requestApproval" {
		permissions := json.RawMessage(`{}`)
		if protocolName != "decline" {
			permissions = approval.permissions
		}
		scope := "turn"
		if protocolName == "acceptForSession" {
			scope = "session"
		}
		return map[string]any{"permissions": permissions, "scope": scope}, nil
	}
	result := map[string]any{"decision": protocolDecision}
	if approval.method == "item/commandExecution/requestApproval" {
		result["acceptSettings"] = nil
	}
	if approval.method == "execCommandApproval" || approval.method == "applyPatchApproval" {
		if protocolName == "accept" {
			result["decision"] = "approved"
		} else if protocolName == "acceptForSession" {
			result["decision"] = "approved_for_session"
		} else {
			result["decision"] = "denied"
		}
	}
	return result, nil
}

func defaultCodexApprovalDecisions() map[string]json.RawMessage {
	return map[string]json.RawMessage{
		"approveOnce":    encodedCodexDecision("accept"),
		"approveSession": encodedCodexDecision("acceptForSession"),
		"deny":           encodedCodexDecision("decline"),
	}
}

func encodedCodexDecision(decision string) json.RawMessage {
	encoded, _ := json.Marshal(decision)
	return encoded
}

func codexApprovalDecisions(method string, params json.RawMessage) map[string]json.RawMessage {
	if method == "execCommandApproval" || method == "applyPatchApproval" {
		return defaultCodexApprovalDecisions()
	}
	if method != "item/commandExecution/requestApproval" {
		return defaultCodexApprovalDecisions()
	}
	var input struct {
		AvailableDecisions json.RawMessage `json:"availableDecisions"`
	}
	if json.Unmarshal(params, &input) != nil || len(input.AvailableDecisions) == 0 || string(input.AvailableDecisions) == "null" {
		return defaultCodexApprovalDecisions()
	}
	var available []json.RawMessage
	if json.Unmarshal(input.AvailableDecisions, &available) != nil {
		return map[string]json.RawMessage{}
	}
	decisions := make(map[string]json.RawMessage)
	for _, encoded := range available {
		var decision string
		if json.Unmarshal(encoded, &decision) == nil {
			switch decision {
			case "accept":
				decisions["approveOnce"] = append(json.RawMessage(nil), encoded...)
			case "acceptForSession":
				decisions["approveSession"] = append(json.RawMessage(nil), encoded...)
			case "decline":
				decisions["deny"] = append(json.RawMessage(nil), encoded...)
			case "cancel":
				if len(decisions["deny"]) == 0 {
					decisions["deny"] = append(json.RawMessage(nil), encoded...)
				}
			}
			continue
		}

		var structured map[string]json.RawMessage
		if json.Unmarshal(encoded, &structured) != nil {
			continue
		}
		if structuredCodexDecisionHasField(structured, "acceptWithExecpolicyAmendment", "execpolicy_amendment") {
			decisions["approveExecPolicyAmendment"] = append(json.RawMessage(nil), encoded...)
		}
		if structuredCodexDecisionHasField(structured, "applyNetworkPolicyAmendment", "network_policy_amendment") {
			decisions["approveNetworkPolicyAmendment"] = append(json.RawMessage(nil), encoded...)
		}
	}
	return decisions
}

func structuredCodexDecisionHasField(decision map[string]json.RawMessage, variant, field string) bool {
	encoded, found := decision[variant]
	if !found {
		return false
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(encoded, &payload) != nil {
		return false
	}
	value, found := payload[field]
	return found && string(value) != "null"
}

func (supervisor *codexSupervisor) resetApproval(id string, approval codexApproval) {
	supervisor.mu.Lock()
	if current, found := supervisor.approvals[id]; found && current.resolving && current.generation == approval.generation {
		approval.resolving = false
		supervisor.approvals[id] = approval
	}
	supervisor.mu.Unlock()
}

func (supervisor *codexSupervisor) finishApproval(id string, approval codexApproval) {
	supervisor.mu.Lock()
	if current, found := supervisor.approvals[id]; found && current.generation == approval.generation {
		delete(supervisor.approvals, id)
	}
	supervisor.mu.Unlock()
}

func (supervisor *codexSupervisor) respondRawForGeneration(
	ctx context.Context,
	generation *codexProcessGeneration,
	id json.RawMessage,
	result any,
) error {
	return supervisor.writeMessageForGeneration(
		ctx,
		generation,
		map[string]any{"id": json.RawMessage(id), "result": result},
	)
}

func (supervisor *codexSupervisor) respondErrorForGeneration(
	generation *codexProcessGeneration,
	id json.RawMessage,
	message string,
) {
	_ = supervisor.writeMessageForGenerationWithin(
		generation,
		map[string]any{
			"id":    json.RawMessage(id),
			"error": map[string]any{"code": -32_000, "message": message},
		},
	)
}

func (supervisor *codexSupervisor) respondRawForGenerationWithin(
	generation *codexProcessGeneration,
	id json.RawMessage,
	result any,
) error {
	return supervisor.writeMessageForGenerationWithin(
		generation,
		map[string]any{"id": json.RawMessage(id), "result": result},
	)
}

func (supervisor *codexSupervisor) writeMessageForGenerationWithin(
	generation *codexProcessGeneration,
	value any,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), supervisor.responseTimeout)
	defer cancel()

	return supervisor.writeMessageForGeneration(ctx, generation, value)
}

func (supervisor *codexSupervisor) writeMessageForGeneration(
	ctx context.Context,
	generation *codexProcessGeneration,
	value any,
) error {
	message, err := json.Marshal(value)
	if err != nil {
		return err
	}
	supervisor.mu.Lock()
	if generation == nil || supervisor.generation != generation || generation.failure != nil {
		supervisor.mu.Unlock()
		return errors.New("Codex app-server generation ended before the approval response was sent")
	}
	stdin := supervisor.stdin
	supervisor.mu.Unlock()
	if stdin == nil {
		return errors.New("Codex app-server is unavailable")
	}
	return supervisor.writeToProcess(ctx, generation, stdin, append(message, '\n'))
}

func (supervisor *codexSupervisor) writeMessage(value any) error {
	message, err := json.Marshal(value)
	if err != nil {
		return err
	}
	supervisor.mu.Lock()
	stdin := supervisor.stdin
	generation := supervisor.generation
	supervisor.mu.Unlock()
	if stdin == nil {
		return errors.New("Codex app-server is unavailable")
	}
	return supervisor.writeToProcess(context.Background(), generation, stdin, append(message, '\n'))
}

func (supervisor *codexSupervisor) writeToProcess(
	ctx context.Context,
	generation *codexProcessGeneration,
	stdin io.Writer,
	message []byte,
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-supervisor.shutdown:
		return errors.New("Codex app-server is shutting down")
	case <-supervisor.writePermit:
	}

	written := make(chan error, 1)
	go func() {
		_, err := stdin.Write(message)
		supervisor.writePermit <- struct{}{}
		written <- err
	}()

	select {
	case <-ctx.Done():
		select {
		case err := <-written:
			return err
		default:
		}
		supervisor.abortProcessWrite(generation, stdin)
		return ctx.Err()
	case <-supervisor.shutdown:
		select {
		case err := <-written:
			return err
		default:
		}
		supervisor.abortProcessWrite(generation, stdin)
		return errors.New("Codex app-server is shutting down")
	case err := <-written:
		return err
	}
}

func (supervisor *codexSupervisor) abortProcessWrite(
	generation *codexProcessGeneration,
	stdin io.Writer,
) {
	if closer, ok := stdin.(io.Closer); ok {
		_ = closer.Close()
	}
	supervisor.mu.Lock()
	var command *exec.Cmd
	if supervisor.generation == generation {
		command = supervisor.command
	}
	supervisor.mu.Unlock()
	killProcessGroup(command)
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
	supervisor.generation.failure = err
	closeSignal(supervisor.generation.ready)
	supervisor.generation = newCodexProcessGeneration()
	pending := supervisor.pending
	supervisor.pending = make(map[string]chan codexPendingResult)
	supervisor.approvals = make(map[string]codexApproval)
	supervisor.activeLoginID = ""
	supervisor.mu.Unlock()
	encoded, _ := json.Marshal(map[string]string{"message": err.Error()})
	for _, channel := range pending {
		channel <- codexPendingResult{err: encoded}
	}
}

func closeSignal(signal chan struct{}) {
	select {
	case <-signal:
	default:
		close(signal)
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
	if err := server.codex.resolveApproval(request.Context(), request.PathValue("id"), input.Decision); err != nil {
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
