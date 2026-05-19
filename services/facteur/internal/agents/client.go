package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Submitter creates AgentRun resources through the Agents service boundary.
type Submitter interface {
	SubmitAgentRun(ctx context.Context, input SubmitAgentRunInput) (SubmitAgentRunResult, error)
}

// HTTPDoer is the subset of http.Client used by HTTPSubmitter.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// SubmitAgentRunInput is the domain-neutral payload Facteur sends to Agents.
type SubmitAgentRunInput struct {
	Namespace               string
	AgentName               string
	DeliveryID              string
	Implementation          map[string]any
	GoalObjective           string
	GoalTokenBudget         int
	RuntimeType             string
	RuntimeConfig           map[string]any
	Parameters              map[string]string
	Secrets                 []string
	SecretBindingRef        string
	VCSProvider             string
	VCSPolicyMode           string
	VCSRequired             bool
	TTLSecondsAfterFinished int
}

// SubmitAgentRunResult captures the accepted AgentRun identity.
type SubmitAgentRunResult struct {
	Namespace    string
	AgentRunName string
	SubmittedAt  time.Time
}

// HTTPSubmitter posts AgentRun creation requests to services/agents.
type HTTPSubmitter struct {
	baseURL string
	client  HTTPDoer
	now     func() time.Time
}

// NewHTTPSubmitter constructs an Agents service client.
func NewHTTPSubmitter(baseURL string, client HTTPDoer) (*HTTPSubmitter, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return nil, fmt.Errorf("agents: base URL is required")
	}
	if _, err := url.ParseRequestURI(trimmed); err != nil {
		return nil, fmt.Errorf("agents: invalid base URL %q: %w", baseURL, err)
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPSubmitter{
		baseURL: trimmed,
		client:  client,
		now:     func() time.Time { return time.Now().UTC() },
	}, nil
}

type namedRef struct {
	Name string `json:"name"`
}

type goalPayload struct {
	Objective   string `json:"objective"`
	TokenBudget int    `json:"tokenBudget,omitempty"`
}

type runtimePayload struct {
	Type   string         `json:"type"`
	Config map[string]any `json:"config,omitempty"`
}

type vcsPolicyPayload struct {
	Required bool   `json:"required,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

type agentRunPayload struct {
	Namespace               string            `json:"namespace"`
	AgentRef                namedRef          `json:"agentRef"`
	Implementation          map[string]any    `json:"implementation"`
	Goal                    *goalPayload      `json:"goal,omitempty"`
	Runtime                 runtimePayload    `json:"runtime"`
	Parameters              map[string]string `json:"parameters,omitempty"`
	Secrets                 []string          `json:"secrets,omitempty"`
	Policy                  map[string]any    `json:"policy,omitempty"`
	VCSRef                  *namedRef         `json:"vcsRef,omitempty"`
	VCSPolicy               *vcsPolicyPayload `json:"vcsPolicy,omitempty"`
	TTLSecondsAfterFinished int               `json:"ttlSecondsAfterFinished,omitempty"`
}

func (s *HTTPSubmitter) SubmitAgentRun(ctx context.Context, input SubmitAgentRunInput) (SubmitAgentRunResult, error) {
	if strings.TrimSpace(input.DeliveryID) == "" {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: delivery ID is required")
	}
	if strings.TrimSpace(input.Namespace) == "" {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: namespace is required")
	}
	if strings.TrimSpace(input.AgentName) == "" {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: agent name is required")
	}
	if strings.TrimSpace(input.RuntimeType) == "" {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: runtime type is required")
	}
	if len(input.Implementation) == 0 {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: implementation is required")
	}

	payload := agentRunPayload{
		Namespace:      input.Namespace,
		AgentRef:       namedRef{Name: input.AgentName},
		Implementation: cloneAnyMap(input.Implementation),
		Runtime: runtimePayload{
			Type:   input.RuntimeType,
			Config: cloneAnyMap(input.RuntimeConfig),
		},
		Parameters:              cloneStringMap(input.Parameters),
		Secrets:                 cloneStringSlice(input.Secrets),
		TTLSecondsAfterFinished: input.TTLSecondsAfterFinished,
	}
	if secretBindingRef := strings.TrimSpace(input.SecretBindingRef); secretBindingRef != "" {
		payload.Policy = map[string]any{"secretBindingRef": secretBindingRef}
	}
	if strings.TrimSpace(input.GoalObjective) != "" {
		payload.Goal = &goalPayload{Objective: strings.TrimSpace(input.GoalObjective), TokenBudget: input.GoalTokenBudget}
	}
	if provider := strings.TrimSpace(input.VCSProvider); provider != "" {
		payload.VCSRef = &namedRef{Name: provider}
	}
	if input.VCSRequired || strings.TrimSpace(input.VCSPolicyMode) != "" {
		payload.VCSPolicy = &vcsPolicyPayload{
			Required: input.VCSRequired,
			Mode:     strings.TrimSpace(input.VCSPolicyMode),
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: marshal AgentRun request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/v1/agent-runs", bytes.NewReader(body))
	if err != nil {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: build AgentRun request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("idempotency-key", input.DeliveryID)

	resp, err := s.client.Do(req)
	if err != nil {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: submit AgentRun: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: read AgentRun response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := extractErrorMessage(responseBody)
		if message == "" {
			message = strings.TrimSpace(string(responseBody))
		}
		if message == "" {
			message = resp.Status
		}
		return SubmitAgentRunResult{}, fmt.Errorf("agents: submit AgentRun failed: status=%d error=%s", resp.StatusCode, message)
	}

	var decoded map[string]any
	if len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, &decoded); err != nil {
			return SubmitAgentRunResult{}, fmt.Errorf("agents: decode AgentRun response: %w", err)
		}
	}

	name := readString(decoded, "resource", "metadata", "name")
	if name == "" {
		name = readString(decoded, "existingAgentRunName")
	}
	if name == "" {
		name = readString(decoded, "agentRun", "externalRunId")
	}
	if name == "" {
		return SubmitAgentRunResult{}, fmt.Errorf("agents: AgentRun response missing resource.metadata.name")
	}
	namespace := readString(decoded, "resource", "metadata", "namespace")
	if namespace == "" {
		namespace = input.Namespace
	}

	return SubmitAgentRunResult{
		Namespace:    namespace,
		AgentRunName: name,
		SubmittedAt:  s.now(),
	}, nil
}

func extractErrorMessage(body []byte) string {
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return ""
	}
	for _, key := range []string{"error", "message", "details"} {
		if value, ok := decoded[key].(string); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func readString(input map[string]any, path ...string) string {
	if len(path) == 0 {
		return ""
	}
	var value any = input
	for _, segment := range path {
		record, ok := value.(map[string]any)
		if !ok {
			return ""
		}
		value = record[segment]
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		if strings.TrimSpace(value) == "" {
			continue
		}
		output[key] = value
	}
	if len(output) == 0 {
		return nil
	}
	return output
}

func cloneAnyMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]any, len(input))
	for key, value := range input {
		if value == nil {
			continue
		}
		output[key] = value
	}
	if len(output) == 0 {
		return nil
	}
	return output
}

func cloneStringSlice(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	output := make([]string, 0, len(input))
	for _, value := range input {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		output = append(output, trimmed)
	}
	if len(output) == 0 {
		return nil
	}
	return output
}
