//go:build linux

package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type guestLifecyclePhaseError struct {
	operation string
	cause     error
}

func (failure *guestLifecyclePhaseError) Error() string {
	return fmt.Sprintf("%s: %v", failure.operation, failure.cause)
}
func (failure *guestLifecyclePhaseError) Unwrap() error { return failure.cause }

func recordLifecycleClock(ctx context.Context, started, finished time.Time, err error) error {
	const operation = "guest.resume.clock"
	_, span := otel.Tracer("nanoagent.lifecycle").Start(ctx, operation, trace.WithTimestamp(finished.Add(-finished.Sub(started))))
	defer span.End(trace.WithTimestamp(finished))
	if err != nil {
		span.SetStatus(codes.Error, "failed")
		return &guestLifecyclePhaseError{operation: operation, cause: err}
	}
	return nil
}

func observeLifecyclePhase(ctx context.Context, operation string, run func(context.Context) error) error {
	child, span := otel.Tracer("nanoagent.lifecycle").Start(ctx, operation)
	defer span.End()
	started := time.Now()
	err := run(child)
	elapsed := time.Since(started)
	if !strings.HasPrefix(operation, "guest.ready.") && (err != nil || elapsed >= 100*time.Millisecond) {
		slog.Info("guest lifecycle slow or failed phase", "operation", operation, "elapsedMs", elapsed.Seconds()*1000, "failed", err != nil)
	}
	if err != nil {
		span.SetStatus(codes.Error, "failed")
		return &guestLifecyclePhaseError{operation: operation, cause: err}
	}
	return nil
}
