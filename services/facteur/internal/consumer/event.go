package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/session"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

const (
	// DefaultSessionTTL defines the default expiry for persisted Discord command sessions.
	DefaultSessionTTL = 15 * time.Minute
)

// ProcessEvent dispatches a command event and persists session metadata when a store is provided.
func ProcessEvent(ctx context.Context, event *facteurpb.CommandEvent, dispatcher bridge.Dispatcher, store session.Store, ttl time.Duration) (bridge.DispatchResult, error) {
	ctx, span := telemetry.Tracer().Start(ctx, "facteur.consumer.process_event", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	command := event.GetCommand()
	userID := userID(event)
	correlationID := event.GetCorrelationId()
	traceID := event.GetTraceId()

	span.SetAttributes(
		attribute.String("facteur.command", command),
		attribute.String("facteur.user_id", userID),
	)
	if traceID != "" {
		span.SetAttributes(attribute.String("facteur.trace_id", traceID))
	}

	if dispatcher == nil {
		err := fmt.Errorf("consumer: dispatcher is required")
		telemetry.RecordCommandFailed(ctx, command)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return bridge.DispatchResult{}, err
	}
	if command == "" {
		err := fmt.Errorf("missing command field")
		telemetry.RecordCommandFailed(ctx, command)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return bridge.DispatchResult{}, err
	}
	options := event.GetOptions()
	if options == nil {
		options = map[string]string{}
	}

	start := time.Now()
	result, err := dispatcher.Dispatch(ctx, bridge.DispatchRequest{
		Command:       command,
		UserID:        userID,
		Options:       options,
		CorrelationID: correlationID,
		TraceID:       traceID,
	})
	if err != nil {
		telemetry.RecordCommandFailed(ctx, command)
		wrapped := fmt.Errorf("dispatch command: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, err.Error())
		return bridge.DispatchResult{}, wrapped
	}
	duration := time.Since(start)
	telemetry.RecordCommandProcessed(ctx, command, duration)

	if correlationID != "" && result.CorrelationID == "" {
		result.CorrelationID = correlationID
	}

	if store != nil && userID != "" {
		payload, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			telemetry.RecordCommandFailed(ctx, command)
			wrapped := fmt.Errorf("persist dispatch result: %w", marshalErr)
			span.RecordError(wrapped)
			span.SetStatus(codes.Error, marshalErr.Error())
			return bridge.DispatchResult{}, wrapped
		}
		sessionTTL := ttl
		if sessionTTL <= 0 {
			sessionTTL = DefaultSessionTTL
		}
		if err := store.Set(ctx, session.DispatchKey(userID), payload, sessionTTL); err != nil {
			telemetry.RecordCommandFailed(ctx, command)
			wrapped := fmt.Errorf("persist dispatch result: %w", err)
			span.RecordError(wrapped)
			span.SetStatus(codes.Error, err.Error())
			return bridge.DispatchResult{}, wrapped
		}
	}

	runName := result.AgentRunName
	if runName == "" {
		runName = result.WorkflowName
	}

	span.SetAttributes(
		attribute.String("facteur.agentrun_name", runName),
		attribute.String("facteur.agentrun_namespace", result.Namespace),
	)
	if result.CorrelationID != "" {
		span.SetAttributes(attribute.String("facteur.correlation_id", result.CorrelationID))
	}
	span.SetStatus(codes.Ok, "event processed")

	return result, nil
}

func userID(event *facteurpb.CommandEvent) string {
	if event == nil {
		return ""
	}
	if user := event.GetUser(); user != nil {
		return user.GetId()
	}
	if member := event.GetMember(); member != nil {
		return member.GetId()
	}
	return ""
}
