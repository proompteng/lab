package telemetry

import (
	"context"
	"log"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

var (
	commandMetricsOnce sync.Once
	commandProcessed   metric.Int64Counter
	commandFailed      metric.Int64Counter
	commandDLQ         metric.Int64Counter
	commandLatency     metric.Float64Histogram
)

func ensureCommandMetrics() {
	commandMetricsOnce.Do(func() {
		meter := Meter()

		var err error
		commandProcessed, err = meter.Int64Counter(
			"facteur_command_events_processed_total",
			metric.WithDescription("Number of Discord command events processed successfully."),
		)
		if err != nil {
			log.Printf("telemetry: init processed counter: %v", err)
		}

		commandFailed, err = meter.Int64Counter(
			"facteur_command_events_failed_total",
			metric.WithDescription("Number of Discord command events that failed."),
		)
		if err != nil {
			log.Printf("telemetry: init failed counter: %v", err)
		}

		commandDLQ, err = meter.Int64Counter(
			"facteur_command_events_dlq_total",
			metric.WithDescription("Number of Discord command events routed to the DLQ."),
		)
		if err != nil {
			log.Printf("telemetry: init dlq counter: %v", err)
		}

		commandLatency, err = meter.Float64Histogram(
			"facteur_command_events_duration_ms",
			metric.WithDescription("Processing latency for Discord command events in milliseconds."),
			metric.WithUnit("ms"),
		)
		if err != nil {
			log.Printf("telemetry: init duration histogram: %v", err)
		}
	})
}

func commandAttributes(command string) []attribute.KeyValue {
	cmd := command
	if cmd == "" {
		cmd = "(unknown)"
	}
	return []attribute.KeyValue{
		attribute.String("command", cmd),
	}
}

// RecordCommandProcessed increments the processed counter and records latency.
func RecordCommandProcessed(ctx context.Context, command string, duration time.Duration) {
	ensureCommandMetrics()

	attrs := commandAttributes(command)
	if commandProcessed != nil {
		commandProcessed.Add(ctx, 1, metric.WithAttributes(attrs...))
	}
	if commandLatency != nil && duration >= 0 {
		commandLatency.Record(ctx, float64(duration.Milliseconds()), metric.WithAttributes(attrs...))
	}
}

// RecordCommandFailed increments the failure counter for the given command.
func RecordCommandFailed(ctx context.Context, command string) {
	ensureCommandMetrics()

	if commandFailed != nil {
		commandFailed.Add(ctx, 1, metric.WithAttributes(commandAttributes(command)...))
	}
}

// RecordCommandDLQ increments the DLQ counter for the given command.
func RecordCommandDLQ(ctx context.Context, command string) {
	ensureCommandMetrics()

	if commandDLQ != nil {
		commandDLQ.Add(ctx, 1, metric.WithAttributes(commandAttributes(command)...))
	}
}
