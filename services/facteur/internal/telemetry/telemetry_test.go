package telemetry

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func resetTelemetryState() {
	setupOnce = sync.Once{}
	setupErr = nil
	shutdownFn = nil
}

func TestSetupAndForceFlush(t *testing.T) {
	resetTelemetryState()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")

	shutdown, err := Setup(context.Background(), "facteur-test", "http/protobuf")
	require.NoError(t, err)
	require.NotNil(t, shutdown)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	if err := ForceFlush(ctx); err != nil &&
		!errors.Is(err, context.DeadlineExceeded) &&
		!strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("force flush: %v", err)
	}

	cancelCtx, cancelShutdown := context.WithCancel(context.Background())
	cancelShutdown()

	if err := shutdown(cancelCtx); err != nil &&
		!errors.Is(err, context.Canceled) &&
		!strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestSetupRespectsExistingProtocolEnv(t *testing.T) {
	resetTelemetryState()
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")

	shutdown, err := Setup(context.Background(), "", "")
	require.NoError(t, err)
	require.NotNil(t, shutdown)
	require.Equal(t, "http/json", os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"))

	cancelCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := shutdown(cancelCtx); err != nil &&
		!errors.Is(err, context.Canceled) &&
		!strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("shutdown: %v", err)
	}
}
