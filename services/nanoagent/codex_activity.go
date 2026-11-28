package main

import (
	"encoding/json"
	"time"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
)

// Work state belongs to the supervised process, independently of event subscribers.
// Pending starts remain inhibitors after an RPC caller disconnects: delivery may
// already have succeeded, and only the process response or exit settles that fact.
func (supervisor *codexSupervisor) activitySnapshot() *pb.CodexActivity {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	select {
	case <-supervisor.generation.ready:
	default:
		return nil
	}
	if supervisor.generation.failure != nil || supervisor.stdin == nil || supervisor.workUnknown {
		return nil
	}
	working := len(supervisor.workRequests) > 0 || len(supervisor.activeTurns) > 0 || len(supervisor.approvals) > 0 || len(supervisor.generation.commands) > 0
	idle := time.Since(supervisor.workChangedAt)
	if working || idle < 0 {
		idle = 0
	}
	return &pb.CodexActivity{Working: working, IdleForMs: uint64(idle / time.Millisecond)}
}

func (supervisor *codexSupervisor) markWorkUnknown(generation *codexProcessGeneration) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.generation == generation {
		supervisor.workUnknown = true
	}
}

func (supervisor *codexSupervisor) observeWork(generation *codexProcessGeneration, message codexRPCMessage) {
	switch message.Method {
	case "turn/started", "turn/completed", "thread/status/changed", "thread/closed":
	default:
		return
	}
	var params struct {
		ThreadID string `json:"threadId"`
		Turn     struct {
			ID string `json:"id"`
		} `json:"turn"`
		Status struct {
			Type string `json:"type"`
		} `json:"status"`
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.generation != generation || generation.failure != nil {
		return
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" {
		supervisor.workUnknown = true
		return
	}
	changed := false
	switch message.Method {
	case "turn/started":
		if params.Turn.ID == "" {
			supervisor.workUnknown = true
			return
		}
		previous, exists := supervisor.activeTurns[params.ThreadID]
		changed = !exists || previous != params.Turn.ID
		supervisor.activeTurns[params.ThreadID] = params.Turn.ID
	case "turn/completed":
		if params.Turn.ID == "" {
			supervisor.workUnknown = true
			return
		}
		if current, exists := supervisor.activeTurns[params.ThreadID]; exists && (current == params.Turn.ID || current == "") {
			delete(supervisor.activeTurns, params.ThreadID)
			changed = true
		}
	case "thread/closed":
		_, changed = supervisor.activeTurns[params.ThreadID]
		delete(supervisor.activeTurns, params.ThreadID)
	case "thread/status/changed":
		switch params.Status.Type {
		case "active":
			if _, exists := supervisor.activeTurns[params.ThreadID]; !exists {
				supervisor.activeTurns[params.ThreadID] = ""
				changed = true
			}
		case "idle", "notLoaded", "systemError":
			_, changed = supervisor.activeTurns[params.ThreadID]
			delete(supervisor.activeTurns, params.ThreadID)
		default:
			supervisor.workUnknown = true
		}
	}
	if changed {
		supervisor.workChangedAt = time.Now()
	}
}

func (supervisor *codexSupervisor) removeUnsentRequest(id string) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	delete(supervisor.pending, id)
	if _, working := supervisor.workRequests[id]; working {
		delete(supervisor.workRequests, id)
		supervisor.workChangedAt = time.Now()
	}
}
