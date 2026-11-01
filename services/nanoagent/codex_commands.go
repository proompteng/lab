package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type codexTurnIdentity struct {
	thread string
	turn   string
}

func (supervisor *codexSupervisor) observeCommands(generation *codexProcessGeneration, message codexRPCMessage) {
	if message.Method != "turn/started" && message.Method != "item/started" {
		return
	}
	var params struct {
		Thread string `json:"threadId"`
		TurnID string `json:"turnId"`
		Turn   struct {
			ID string `json:"id"`
		} `json:"turn"`
		Item struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"item"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		supervisor.markWorkUnknown(generation)
		return
	}
	if message.Method == "item/started" && params.Item.Type != "commandExecution" {
		if params.Item.Type == "" {
			supervisor.markWorkUnknown(generation)
		}
		return
	}
	if message.Method == "turn/started" {
		params.TurnID = params.Turn.ID
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.generation != generation || generation.failure != nil {
		return
	}
	if params.Thread == "" || params.TurnID == "" || len(params.Thread) > 256 || len(params.TurnID) > 256 {
		supervisor.workUnknown = true
		return
	}
	identity := codexTurnIdentity{thread: params.Thread, turn: params.TurnID}
	commands, found := generation.commands[identity]
	if message.Method == "turn/started" {
		if !found {
			if len(generation.commands) >= 64 {
				supervisor.workUnknown = true
				return
			}
			generation.commands[identity] = make(map[string]struct{})
		}
		return
	}
	if !found || params.Item.ID == "" || len(params.Item.ID) > 256 || len(commands) >= 10_000 {
		supervisor.workUnknown = true
		return
	}
	commands[params.Item.ID] = struct{}{}
}

func (supervisor *codexSupervisor) finishCommandTracking(generation *codexProcessGeneration, identity codexTurnIdentity) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	delete(generation.commands, identity)
	if supervisor.generation == generation {
		supervisor.workChangedAt = time.Now()
	}
}

func (supervisor *codexSupervisor) finishInterruptedTurn(
	generation *codexProcessGeneration,
	identity codexTurnIdentity,
	items map[string]struct{},
	path string,
	receipt codexTerminalReceipt,
) {
	retryDelay := time.Second
	for supervisor.isCurrentGeneration(generation) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := supervisor.stopTurnCommands(ctx, generation, identity, items)
		cancel()
		if err == nil {
			receipt.ProcessesStopped = true
			if writeCodexReceipt(path, receipt) == nil {
				supervisor.finishCommandTracking(generation, identity)
				return
			}
		}
		timer := time.NewTimer(retryDelay)
		select {
		case <-timer.C:
		case <-supervisor.shutdown:
			timer.Stop()
			return
		}
		retryDelay = min(retryDelay*2, 30*time.Second)
	}
}

func (supervisor *codexSupervisor) stopTurnCommands(
	ctx context.Context,
	generation *codexProcessGeneration,
	identity codexTurnIdentity,
	items map[string]struct{},
) error {
	if len(items) == 0 {
		return nil
	}
	processes, err := supervisor.turnCommandProcesses(ctx, generation, identity.thread, items)
	if err != nil {
		return err
	}
	for _, process := range processes {
		params, _ := json.Marshal(map[string]string{"threadId": identity.thread, "processId": process})
		result, err := supervisor.request(ctx, "thread/backgroundTerminals/terminate", params, true, generation)
		if err != nil {
			return err
		}
		var response struct {
			Terminated *bool `json:"terminated"`
		}
		if json.Unmarshal(result.result, &response) != nil || response.Terminated == nil {
			return errors.New("invalid native command termination response")
		}
	}
	remaining, err := supervisor.turnCommandProcesses(ctx, generation, identity.thread, items)
	if err != nil {
		return err
	}
	if len(remaining) != 0 {
		return errors.New("interrupted native commands are still running")
	}
	return nil
}

func (supervisor *codexSupervisor) turnCommandProcesses(
	ctx context.Context,
	generation *codexProcessGeneration,
	thread string,
	items map[string]struct{},
) ([]string, error) {
	var processes []string
	var cursor *string
	seen := make(map[string]bool)
	for range 100 {
		params, _ := json.Marshal(map[string]any{"threadId": thread, "limit": 100, "cursor": cursor})
		result, err := supervisor.request(ctx, "thread/backgroundTerminals/list", params, true, generation)
		if err != nil {
			return nil, err
		}
		var page struct {
			Data *[]struct {
				Item    string `json:"itemId"`
				Process string `json:"processId"`
			} `json:"data"`
			Next *string `json:"nextCursor"`
		}
		if json.Unmarshal(result.result, &page) != nil || page.Data == nil || len(*page.Data) > 100 {
			return nil, errors.New("invalid native command inventory")
		}
		for _, process := range *page.Data {
			if process.Item == "" || process.Process == "" || len(process.Item) > 256 || len(process.Process) > 256 {
				return nil, errors.New("invalid native command identity")
			}
			if _, owned := items[process.Item]; owned {
				processes = append(processes, process.Process)
			}
		}
		if page.Next == nil || *page.Next == "" {
			return processes, nil
		}
		if seen[*page.Next] {
			return nil, errors.New("native command inventory repeated its cursor")
		}
		seen[*page.Next] = true
		cursor = page.Next
	}
	return nil, errors.New("native command inventory exceeds the cleanup budget")
}
