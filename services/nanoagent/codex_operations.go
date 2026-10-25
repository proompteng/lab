package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var (
	errCodexOperationRejected = errors.New("Codex rejected the operation before dispatch")
	errCodexOperationConflict = errors.New("Codex operation ID already has different input")
	errCodexOperationUnknown  = errors.New("Codex operation outcome needs reconciliation; the request was not resent")
	codexOperationID          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type codexOperation struct {
	Version    int             `json:"version"`
	ID         string          `json:"id"`
	Digest     string          `json:"digest"`
	Method     string          `json:"method"`
	Thread     string          `json:"thread"`
	State      string          `json:"state"`
	Generation string          `json:"generation"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      json.RawMessage `json:"error,omitempty"`
}

func (supervisor *codexSupervisor) operation(ctx context.Context, method string, params json.RawMessage) (codexCallResult, error) {
	var input struct {
		ID     string `json:"clientUserMessageId"`
		Thread string `json:"threadId"`
	}
	if json.Unmarshal(params, &input) != nil || !codexOperationID.MatchString(input.ID) || input.Thread == "" {
		return codexCallResult{}, errors.New("a stable UUID clientUserMessageId and threadId are required")
	}
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return codexCallResult{}, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return codexCallResult{}, errors.New("invalid Codex operation input")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return codexCallResult{}, err
	}
	digest := sha256.Sum256(append([]byte(method+"\n"), canonical...))
	op := codexOperation{Version: 1, ID: input.ID, Digest: hex.EncodeToString(digest[:]), Method: method, Thread: input.Thread, State: "dispatching"}
	supervisor.operationMu.Lock()
	defer supervisor.operationMu.Unlock()
	if err := ctx.Err(); err != nil {
		return codexCallResult{}, err
	}

	supervisor.mu.Lock()
	op.Generation = supervisor.generation.id
	supervisor.mu.Unlock()

	directory := filepath.Join(supervisor.cwd, ".tengri", "codex-operations")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return codexCallResult{}, fmt.Errorf("prepare Codex operation journal: %w", err)
	}
	for _, parent := range []string{filepath.Dir(directory), supervisor.cwd} {
		file, err := os.Open(parent)
		if err != nil {
			return codexCallResult{}, err
		}
		if err := errors.Join(file.Sync(), file.Close()); err != nil {
			return codexCallResult{}, err
		}
	}
	path := filepath.Join(directory, input.ID+".json")
	previous, err := readCodexOperation(path)
	if err == nil {
		if previous.Digest != op.Digest || previous.Method != method || previous.Thread != input.Thread {
			return codexCallResult{}, errCodexOperationConflict
		}
		if previous.State != "completed" {
			recovered, err := supervisor.reconcileOperation(ctx, previous)
			if err != nil {
				return codexCallResult{}, err
			}
			if err := writeCodexOperation(path, recovered); err != nil {
				return codexCallResult{}, errCodexOperationUnknown
			}
			return codexCallResult{result: recovered.Result}, nil
		}
		if len(previous.Error) != 0 {
			return codexCallResult{}, fmt.Errorf("%w: %v", errCodexOperationRejected, codexRPCErrorFromRaw(previous.Error))
		}
		return codexCallResult{result: previous.Result}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return codexCallResult{}, fmt.Errorf("read Codex operation journal: %w", err)
	}
	activePath := filepath.Join(directory, ".pending.json")
	if method == "turn/start" || method == "turn/steer" {
		active, err := readCodexOperation(activePath)
		if err == nil {
			committed, err := readCodexOperation(filepath.Join(directory, active.ID+".json"))
			if err != nil || committed.State != "completed" {
				return codexCallResult{}, errCodexOperationUnknown
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return codexCallResult{}, fmt.Errorf("read pending Codex operation: %w", err)
		}
	}
	if err := writeCodexOperation(path, op); err != nil {
		return codexCallResult{}, err
	}
	if method == "turn/start" || method == "turn/steer" {
		if err := writeCodexOperation(activePath, op); err != nil {
			return codexCallResult{}, err
		}
	}
	result, requestErr := supervisor.dispatchOperation(ctx, method, params)
	if result.generation != nil {
		op.Generation = result.generation.id
	}
	if requestErr != nil {
		var rpcError *codexRPCError
		if !errors.As(requestErr, &rpcError) || (rpcError.code != -32600 && rpcError.code != -32601 && rpcError.code != -32602) {
			return codexCallResult{}, fmt.Errorf("%w: %v", errCodexOperationUnknown, requestErr)
		}
		op.Error = rpcError.raw
		requestErr = fmt.Errorf("%w: %v", errCodexOperationRejected, requestErr)
	} else {
		op.Result = result.result
	}
	op.State = "completed"
	if err := writeCodexOperation(path, op); err != nil {
		return codexCallResult{}, fmt.Errorf("%w: persist accepted response: %v", errCodexOperationUnknown, err)
	}
	return result, requestErr
}

func (supervisor *codexSupervisor) reconcileOperation(ctx context.Context, op codexOperation) (codexOperation, error) {
	if op.Method != "turn/start" && op.Method != "turn/steer" {
		return op, errCodexOperationUnknown
	}
	var cursor any
	seen := make(map[string]bool)
	turn := ""
	bytes := 0
	for page := 0; page < 256; page++ {
		params, _ := json.Marshal(map[string]any{"threadId": op.Thread, "cursor": cursor, "limit": 100, "sortDirection": "desc"})
		result, err := supervisor.request(ctx, "thread/items/list", params, true, nil)
		if err != nil {
			return op, errCodexOperationUnknown
		}
		bytes += len(result.result)
		if bytes > 64<<20 {
			return op, errCodexOperationUnknown
		}
		var items struct {
			Data []struct {
				Turn string `json:"turnId"`
				Item struct {
					Type   string `json:"type"`
					Client string `json:"clientId"`
				} `json:"item"`
			} `json:"data"`
			Next *string `json:"nextCursor"`
		}
		if json.Unmarshal(result.result, &items) != nil {
			return op, errCodexOperationUnknown
		}
		for _, entry := range items.Data {
			if entry.Item.Type == "userMessage" && entry.Item.Client == op.ID {
				if turn != "" || entry.Turn == "" {
					return op, errCodexOperationUnknown
				}
				turn = entry.Turn
			}
		}
		if items.Next == nil {
			if turn == "" {
				return op, errCodexOperationUnknown
			}
			value := map[string]any{"turnId": turn}
			if op.Method == "turn/start" {
				value = map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress"}}
			}
			op.Result, _ = json.Marshal(value)
			op.State = "completed"
			return op, nil
		}
		if *items.Next == "" || seen[*items.Next] {
			return op, errCodexOperationUnknown
		}
		seen[*items.Next] = true
		cursor = *items.Next
	}
	return op, errCodexOperationUnknown
}

func (supervisor *codexSupervisor) dispatchOperation(ctx context.Context, method string, params json.RawMessage) (codexCallResult, error) {
	if method != "tengri/resolveApproval" {
		result, err := supervisor.request(ctx, method, params, true, nil)
		var input struct {
			Thread string `json:"threadId"`
		}
		var rpcError *codexRPCError
		if method != "turn/start" || result.generation == nil || json.Unmarshal(params, &input) != nil ||
			!errors.As(err, &rpcError) || rpcError.code != -32600 || rpcError.message != "thread not found: "+input.Thread {
			return result, err
		}
		resume, _ := json.Marshal(map[string]any{"threadId": input.Thread, "historyMode": "paginated", "excludeTurns": true})
		if _, err := supervisor.request(ctx, "thread/resume", resume, true, result.generation); err != nil {
			return result, err
		}
		return supervisor.request(ctx, method, params, true, result.generation)
	}
	var input struct {
		Thread   string          `json:"threadId"`
		Approval string          `json:"approvalId"`
		Decision string          `json:"decision"`
		Response json.RawMessage `json:"response"`
		Turn     string          `json:"expectedTurnId"`
	}
	if json.Unmarshal(params, &input) != nil || (input.Decision == "") == (len(input.Response) == 0) {
		return codexCallResult{}, errors.New("invalid approval control")
	}
	supervisor.mu.Lock()
	approval, found := supervisor.approvals[input.Approval]
	var message struct {
		Params struct {
			Thread string `json:"threadId"`
			Turn   string `json:"turnId"`
		} `json:"params"`
	}
	valid := found && approval.generation == supervisor.generation && json.Unmarshal(approval.raw, &message) == nil && message.Params.Thread == input.Thread && input.Turn != "" && message.Params.Turn == input.Turn
	supervisor.mu.Unlock()
	if !valid {
		return codexCallResult{}, errors.New("approval is stale or belongs to another conversation")
	}
	var err error
	if input.Decision != "" {
		err = supervisor.resolveApproval(ctx, input.Approval, input.Decision)
	} else {
		err = supervisor.resolveInput(ctx, input.Approval, input.Response)
	}
	return codexCallResult{result: json.RawMessage(`{}`)}, err
}

func readCodexOperation(path string) (codexOperation, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return codexOperation{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > codexProtocolLineMaxBytes {
		return codexOperation{}, errors.New("invalid Codex operation journal")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return codexOperation{}, err
	}
	var op codexOperation
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&op) != nil || decoder.Decode(new(any)) != io.EOF || op.Version != 1 || !codexOperationID.MatchString(op.ID) ||
		len(op.Digest) != 64 || (op.State != "dispatching" && op.State != "completed") ||
		(op.State == "completed" && (len(op.Result) == 0) == (len(op.Error) == 0)) {
		return codexOperation{}, errors.New("invalid Codex operation journal")
	}
	return op, nil
}

func writeCodexOperation(path string, op codexOperation) error {
	return writeCodexReceipt(path, op)
}

func writeCodexReceipt(path string, value any) error {
	content, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".operation-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(content)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

type codexTerminalReceipt struct {
	Version          int    `json:"version"`
	Thread           string `json:"thread"`
	Turn             string `json:"turn"`
	Generation       string `json:"generation"`
	Status           string `json:"status"`
	ProcessesStopped bool   `json:"processesStopped,omitempty"`
}

func (supervisor *codexSupervisor) terminalPath(thread, turn, generation string) string {
	digest := sha256.Sum256([]byte(thread + "\n" + turn + "\n" + generation))
	return filepath.Join(supervisor.cwd, ".tengri", "codex-operations", fmt.Sprintf("turn-%x.json", digest))
}

func (supervisor *codexSupervisor) recordTerminal(generation *codexProcessGeneration, params json.RawMessage) error {
	var input struct {
		Thread string `json:"threadId"`
		Turn   struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
	}
	if json.Unmarshal(params, &input) != nil || input.Thread == "" || input.Turn.ID == "" || len(input.Thread) > 256 || len(input.Turn.ID) > 256 ||
		(input.Turn.Status != "completed" && input.Turn.Status != "failed" && input.Turn.Status != "interrupted") {
		return errors.New("invalid native terminal outcome")
	}
	identity := codexTurnIdentity{thread: input.Thread, turn: input.Turn.ID}
	if supervisor.terminalStatus(input.Thread, input.Turn.ID, generation.id) == input.Turn.Status {
		supervisor.finishCommandTracking(generation, identity)
		return nil
	}
	path := supervisor.terminalPath(input.Thread, input.Turn.ID, generation.id)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	receipt := codexTerminalReceipt{Version: 2, Thread: input.Thread, Turn: input.Turn.ID, Generation: generation.id, Status: input.Turn.Status}
	if receipt.Status == "interrupted" {
		supervisor.mu.Lock()
		commands, found := generation.commands[identity]
		complete := found && !supervisor.workUnknown && supervisor.generation == generation && generation.failure == nil
		items := make(map[string]struct{}, len(commands))
		for id := range commands {
			items[id] = struct{}{}
		}
		supervisor.mu.Unlock()
		if !complete {
			supervisor.markWorkUnknown(generation)
			return errors.New("interrupted command ownership is unavailable")
		}
		go supervisor.finishInterruptedTurn(generation, identity, items, path, receipt)
		return nil
	}
	if err := writeCodexReceipt(path, receipt); err != nil {
		return err
	}
	supervisor.finishCommandTracking(generation, identity)
	return nil
}

func (supervisor *codexSupervisor) terminalStatus(thread, turn, generation string) string {
	if thread == "" || turn == "" || generation == "" {
		return ""
	}
	path := supervisor.terminalPath(thread, turn, generation)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var receipt codexTerminalReceipt
	if json.Unmarshal(raw, &receipt) != nil || receipt.Version != 2 || receipt.Thread != thread || receipt.Turn != turn || receipt.Generation != generation || (receipt.Status == "interrupted" && !receipt.ProcessesStopped) {
		return ""
	}
	switch receipt.Status {
	case "completed", "failed", "interrupted":
		return receipt.Status
	default:
		return ""
	}
}
