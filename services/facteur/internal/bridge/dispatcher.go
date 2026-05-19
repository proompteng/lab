package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/proompteng/lab/services/facteur/internal/agents"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

// DispatchRequest describes an AgentRun submission triggered by a Discord command.
type DispatchRequest struct {
	Command       string
	UserID        string
	Options       map[string]string
	CorrelationID string
	TraceID       string
}

// DispatchResult captures AgentRun submission metadata to echo back to Discord.
type DispatchResult struct {
	Namespace     string
	AgentRunName  string
	Message       string
	CorrelationID string
	TraceID       string
}

// StatusReport summarises the configured Agents dispatch target.
type StatusReport struct {
	Namespace string
	AgentName string
	Ready     bool
	Message   string
}

// Dispatcher bridges Discord command handlers to the Agents service.
type Dispatcher interface {
	Dispatch(ctx context.Context, req DispatchRequest) (DispatchResult, error)
	Status(ctx context.Context) (StatusReport, error)
}

type ReadyChecker interface {
	CheckReady(ctx context.Context) (agents.ReadyStatus, error)
}

// ServiceConfig provides the static configuration needed to submit AgentRuns.
type ServiceConfig struct {
	Namespace               string
	AgentName               string
	RuntimeType             string
	RuntimeConfig           map[string]any
	Parameters              map[string]string
	Secrets                 []string
	SecretBindingRef        string
	VCSProvider             string
	VCSPolicyMode           string
	VCSRequired             bool
	GoalTokenBudget         int
	TTLSecondsAfterFinished int
}

// AgentRunDispatcher is the concrete implementation of Dispatcher.
type AgentRunDispatcher struct {
	submitter        agents.Submitter
	ready            ReadyChecker
	cfg              ServiceConfig
	newCorrelationID func(DispatchRequest, map[string]any) (string, error)
}

// NewDispatcher constructs an AgentRunDispatcher.
func NewDispatcher(submitter agents.Submitter, ready ReadyChecker, cfg ServiceConfig) (*AgentRunDispatcher, error) {
	if submitter == nil {
		return nil, fmt.Errorf("bridge: agents submitter is required")
	}
	if cfg.Namespace == "" {
		return nil, fmt.Errorf("bridge: namespace is required")
	}
	if cfg.AgentName == "" {
		return nil, fmt.Errorf("bridge: agent name is required")
	}
	if cfg.RuntimeType == "" {
		return nil, fmt.Errorf("bridge: runtime type is required")
	}

	return &AgentRunDispatcher{
		submitter: submitter,
		ready:     ready,
		cfg: ServiceConfig{
			Namespace:               cfg.Namespace,
			AgentName:               cfg.AgentName,
			RuntimeType:             cfg.RuntimeType,
			RuntimeConfig:           cloneAny(cfg.RuntimeConfig),
			Parameters:              clone(cfg.Parameters),
			Secrets:                 cloneSlice(cfg.Secrets),
			SecretBindingRef:        cfg.SecretBindingRef,
			VCSProvider:             cfg.VCSProvider,
			VCSPolicyMode:           cfg.VCSPolicyMode,
			VCSRequired:             cfg.VCSRequired,
			GoalTokenBudget:         cfg.GoalTokenBudget,
			TTLSecondsAfterFinished: cfg.TTLSecondsAfterFinished,
		},
		newCorrelationID: defaultCorrelationID,
	}, nil
}

// Dispatch submits an AgentRun through the Agents service boundary.
func (d *AgentRunDispatcher) Dispatch(ctx context.Context, req DispatchRequest) (DispatchResult, error) {
	ctx, span := telemetry.Tracer().Start(ctx, "facteur.bridge.dispatch", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()

	span.SetAttributes(
		attribute.String("facteur.command", req.Command),
		attribute.String("facteur.user_id", req.UserID),
		attribute.String("facteur.agent_name", d.cfg.AgentName),
		attribute.String("facteur.target_namespace", d.cfg.Namespace),
	)
	if req.TraceID != "" {
		span.SetAttributes(attribute.String("facteur.trace_id", req.TraceID))
	}

	payload, err := parsePayload(req.Options)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid dispatch payload")
		return DispatchResult{}, err
	}

	prompt := optionValue(req.Options, payload, "prompt")
	if prompt == "" {
		err := fmt.Errorf("bridge: payload.prompt is required")
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return DispatchResult{}, err
	}

	correlationID, err := d.resolveCorrelationID(req, payload)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "build dispatch correlation")
		return DispatchResult{}, err
	}

	parameters := buildParameters(d.cfg.Parameters, req, payload)
	implementation := buildImplementation(req, payload, prompt)

	result, err := d.submitter.SubmitAgentRun(ctx, agents.SubmitAgentRunInput{
		Namespace:               d.cfg.Namespace,
		AgentName:               d.cfg.AgentName,
		DeliveryID:              correlationID,
		Implementation:          implementation,
		GoalObjective:           prompt,
		GoalTokenBudget:         d.cfg.GoalTokenBudget,
		RuntimeType:             d.cfg.RuntimeType,
		RuntimeConfig:           cloneAny(d.cfg.RuntimeConfig),
		Parameters:              parameters,
		Secrets:                 cloneSlice(d.cfg.Secrets),
		SecretBindingRef:        d.cfg.SecretBindingRef,
		VCSProvider:             d.cfg.VCSProvider,
		VCSPolicyMode:           d.cfg.VCSPolicyMode,
		VCSRequired:             d.cfg.VCSRequired,
		TTLSecondsAfterFinished: d.cfg.TTLSecondsAfterFinished,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return DispatchResult{}, fmt.Errorf("bridge: submit AgentRun: %w", err)
	}

	message := fmt.Sprintf("AgentRun `%s` submitted to namespace `%s`.", result.AgentRunName, result.Namespace)

	span.SetAttributes(
		attribute.String("facteur.agentrun_name", result.AgentRunName),
		attribute.String("facteur.agentrun_namespace", result.Namespace),
		attribute.String("facteur.correlation_id", correlationID),
	)
	span.SetStatus(codes.Ok, "AgentRun dispatched")

	return DispatchResult{
		Namespace:     result.Namespace,
		AgentRunName:  result.AgentRunName,
		Message:       message,
		CorrelationID: correlationID,
		TraceID:       req.TraceID,
	}, nil
}

// Status verifies that the configured Agents service is available.
func (d *AgentRunDispatcher) Status(ctx context.Context) (StatusReport, error) {
	ctx, span := telemetry.Tracer().Start(ctx, "facteur.bridge.status", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()

	span.SetAttributes(
		attribute.String("facteur.agent_name", d.cfg.AgentName),
		attribute.String("facteur.target_namespace", d.cfg.Namespace),
	)

	ready := agents.ReadyStatus{Ready: true, Message: "Agents submitter configured"}
	if d.ready != nil {
		status, err := d.ready.CheckReady(ctx)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			return StatusReport{}, fmt.Errorf("bridge: agents readiness: %w", err)
		}
		ready = status
	}

	message := ready.Message
	if message == "" {
		message = fmt.Sprintf("Agents service for Agent `%s` in namespace `%s` is ready.", d.cfg.AgentName, d.cfg.Namespace)
		if !ready.Ready {
			message = fmt.Sprintf("Agents service for Agent `%s` in namespace `%s` is not ready.", d.cfg.AgentName, d.cfg.Namespace)
		}
	}

	span.SetAttributes(
		attribute.Bool("facteur.agents_ready", ready.Ready),
		attribute.String("facteur.status_message", message),
	)
	span.SetStatus(codes.Ok, "status retrieved")

	return StatusReport{
		Namespace: d.cfg.Namespace,
		AgentName: d.cfg.AgentName,
		Ready:     ready.Ready,
		Message:   message,
	}, nil
}

func (d *AgentRunDispatcher) resolveCorrelationID(req DispatchRequest, payload map[string]any) (string, error) {
	for _, candidate := range []string{
		strings.TrimSpace(req.CorrelationID),
		payloadString(payload, "deliveryId"),
		payloadString(payload, "delivery_id"),
		payloadString(payload, "runId"),
		payloadString(payload, "run_id"),
	} {
		if candidate != "" {
			return candidate, nil
		}
	}
	return d.newCorrelationID(req, payload)
}

func parsePayload(options map[string]string) (map[string]any, error) {
	raw := strings.TrimSpace(options["payload"])
	if raw == "" {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, fmt.Errorf("bridge: decode payload: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return payload, nil
}

func buildParameters(base map[string]string, req DispatchRequest, payload map[string]any) map[string]string {
	params := clone(base)
	for key, value := range req.Options {
		params[key] = value
	}
	for key, value := range payload {
		if scalar := scalarString(value); scalar != "" {
			params[key] = scalar
		}
	}
	params["command"] = req.Command
	if req.UserID != "" {
		params["discordUserId"] = req.UserID
	}
	if req.TraceID != "" {
		params["traceId"] = req.TraceID
	}
	if _, ok := params["stage"]; !ok {
		params["stage"] = resolveStage(req, payload)
	}
	return params
}

func buildImplementation(req DispatchRequest, payload map[string]any, prompt string) map[string]any {
	stage := resolveStage(req, payload)
	summary := firstNonEmpty(payloadString(payload, "title"), payloadString(payload, "issueTitle"))
	if summary == "" {
		summary = fmt.Sprintf("Facteur %s request", firstNonEmpty(req.Command, "dispatch"))
	}

	source := map[string]any{"provider": "discord"}
	if req.UserID != "" {
		source["externalId"] = req.UserID
	}
	if repository := payloadString(payload, "repository"); repository != "" {
		source["repository"] = repository
		source["provider"] = "github"
		if issueNumber := payloadString(payload, "issueNumber"); issueNumber != "" {
			source["externalId"] = fmt.Sprintf("%s#%s", repository, issueNumber)
		}
	}
	if issueURL := payloadString(payload, "issueUrl"); issueURL != "" {
		source["url"] = issueURL
	}

	metadata := map[string]any{
		"command": req.Command,
		"stage":   stage,
	}
	if req.UserID != "" {
		metadata["discordUserId"] = req.UserID
	}
	if req.TraceID != "" {
		metadata["traceId"] = req.TraceID
	}
	for _, key := range []string{
		"repository",
		"issueNumber",
		"runId",
		"base",
		"head",
		"postToGithub",
		"discordChannelDryRun",
	} {
		if value := payloadString(payload, key); value != "" {
			metadata[key] = value
		}
	}

	return map[string]any{
		"summary": summary,
		"text":    prompt,
		"contract": map[string]any{
			"requiredKeys": []string{"prompt", "stage"},
		},
		"source":   source,
		"metadata": metadata,
	}
}

func optionValue(options map[string]string, payload map[string]any, key string) string {
	if value := strings.TrimSpace(options[key]); value != "" {
		return value
	}
	return payloadString(payload, key)
}

func resolveStage(req DispatchRequest, payload map[string]any) string {
	stage := payloadString(payload, "stage")
	if stage == "" {
		stage = strings.TrimSpace(req.Options["stage"])
	}
	if stage == "" {
		stage = "implementation"
	}
	return stage
}

func payloadString(payload map[string]any, key string) string {
	return scalarString(payload[key])
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		if strings.EqualFold(strings.TrimSpace(typed), "null") {
			return ""
		}
		return strings.TrimSpace(typed)
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func defaultCorrelationID(req DispatchRequest, _ map[string]any) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", fmt.Errorf("bridge: generate dispatch id: %w", err)
	}
	prefix := sanitizeIDPart(req.Command)
	if prefix == "" {
		prefix = "dispatch"
	}
	return fmt.Sprintf("facteur-%s-%s-%s", prefix, time.Now().UTC().Format("20060102T150405"), hex.EncodeToString(suffix[:])), nil
}

func sanitizeIDPart(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func clone(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}

	out := make(map[string]string, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}

func cloneAny(input map[string]any) map[string]any {
	if len(input) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}

func cloneSlice(input []string) []string {
	if len(input) == 0 {
		return []string{}
	}
	out := make([]string, len(input))
	copy(out, input)
	return out
}
