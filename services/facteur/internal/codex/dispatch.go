package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
)

const planningCommand = "codex-planning"

// DispatchConfig controls Codex-triggered workflow submissions.
type DispatchConfig struct {
	PlanningEnabled  bool
	PayloadOverrides map[string]string
}

func cloneOverrides(overrides map[string]string) map[string]string {
	if len(overrides) == 0 {
		return map[string]string{}
	}
	cloned := make(map[string]string, len(overrides))
	for k, v := range overrides {
		cloned[k] = v
	}
	return cloned
}

// DispatchPlanning submits a planning workflow for the provided Codex task.
func DispatchPlanning(ctx context.Context, dispatcher bridge.Dispatcher, task *froussardpb.CodexTask, overrides map[string]string) (bridge.DispatchResult, error) {
	if dispatcher == nil {
		return bridge.DispatchResult{}, fmt.Errorf("codex dispatch: dispatcher is required")
	}
	if task == nil {
		return bridge.DispatchResult{}, fmt.Errorf("codex dispatch: task is nil")
	}

	req, err := buildPlanningDispatchRequest(task, overrides)
	if err != nil {
		return bridge.DispatchResult{}, err
	}

	return dispatcher.Dispatch(ctx, req)
}

func buildPlanningDispatchRequest(task *froussardpb.CodexTask, overrides map[string]string) (bridge.DispatchRequest, error) {
	if task.GetStage() != froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING {
		return bridge.DispatchRequest{}, fmt.Errorf("codex dispatch: stage %s is not supported", task.GetStage())
	}

	prompt := strings.TrimSpace(task.GetPrompt())
	if prompt == "" {
		return bridge.DispatchRequest{}, fmt.Errorf("codex dispatch: planning prompt is required")
	}

	payload := map[string]any{
		"stage":  "planning",
		"prompt": prompt,
	}

	if repo := strings.TrimSpace(task.GetRepository()); repo != "" {
		payload["repository"] = repo
	}
	if base := strings.TrimSpace(task.GetBase()); base != "" {
		payload["base"] = base
	}
	if head := strings.TrimSpace(task.GetHead()); head != "" {
		payload["head"] = head
	}
	if issueNumber := task.GetIssueNumber(); issueNumber != 0 {
		payload["issueNumber"] = issueNumber
	}
	if title := strings.TrimSpace(task.GetIssueTitle()); title != "" {
		payload["title"] = title
	}
	if body := strings.TrimSpace(task.GetIssueBody()); body != "" {
		payload["body"] = body
	}
	if url := strings.TrimSpace(task.GetIssueUrl()); url != "" {
		payload["issueUrl"] = url
	}
	if sender := strings.TrimSpace(task.GetSender()); sender != "" {
		payload["sender"] = sender
	}
	if task.GetPlanCommentId() != 0 {
		payload["planCommentId"] = task.GetPlanCommentId()
	}
	if commentURL := strings.TrimSpace(task.GetPlanCommentUrl()); commentURL != "" {
		payload["planCommentUrl"] = commentURL
	}
	if commentBody := strings.TrimSpace(task.GetPlanCommentBody()); commentBody != "" {
		payload["planCommentBody"] = commentBody
	}
	if issuedAt := task.GetIssuedAt(); issuedAt != nil {
		payload["issuedAt"] = issuedAt.AsTime().UTC().Format(time.RFC3339)
	}

	if delivery := strings.TrimSpace(task.GetDeliveryId()); delivery != "" {
		payload["runId"] = delivery
	}

	mergedOverrides := cloneOverrides(overrides)
	for key, raw := range mergedOverrides {
		if parsed, err := parseOverrideValue(raw); err == nil {
			payload[key] = parsed
		} else {
			payload[key] = raw
		}
	}

	options := map[string]string{}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return bridge.DispatchRequest{}, fmt.Errorf("codex dispatch: marshal payload: %w", err)
	}
	options["payload"] = string(encoded)

	correlationID := strings.TrimSpace(task.GetDeliveryId())

	return bridge.DispatchRequest{
		Command:       planningCommand,
		UserID:        strings.TrimSpace(task.GetSender()),
		Options:       options,
		CorrelationID: correlationID,
		TraceID:       correlationID,
	}, nil
}

func parseOverrideValue(value string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	var out any
	if err := decoder.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}
