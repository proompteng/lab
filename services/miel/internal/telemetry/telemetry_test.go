package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSetupAndShutdown(t *testing.T) {
	otlpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer otlpServer.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", otlpServer.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", otlpServer.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", otlpServer.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	shutdown, err := Setup(ctx, "miel-test", "http/protobuf")
	if err != nil {
		t.Fatalf("Setup returned error: %v", err)
	}

	if err := ForceFlush(ctx); err != nil {
		t.Fatalf("ForceFlush returned error: %v", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	if err := shutdown(shutdownCtx); err != nil {
		t.Fatalf("shutdown returned error: %v", err)
	}
}
