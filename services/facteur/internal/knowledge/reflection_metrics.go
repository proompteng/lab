package knowledge

import (
	"context"
	"log"
	"sync"

	"github.com/proompteng/lab/services/facteur/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

var (
	reflectionMetricsOnce sync.Once
	reflectionsSaved      metric.Int64Counter
	reflectionsRetrieved  metric.Int64Counter
)

func ensureReflectionMetrics() {
	reflectionMetricsOnce.Do(func() {
		meter := telemetry.Meter()

		var err error
		reflectionsSaved, err = meter.Int64Counter(
			"facteur_reflections_saved_total",
			metric.WithDescription("Number of reflections persisted to codex_kb.reflections."),
		)
		if err != nil {
			log.Printf("knowledge: init reflections saved counter: %v", err)
		}

		reflectionsRetrieved, err = meter.Int64Counter(
			"facteur_reflections_retrieved_total",
			metric.WithDescription("Number of reflections retrieved by similarity search."),
		)
		if err != nil {
			log.Printf("knowledge: init reflections retrieved counter: %v", err)
		}
	})
}

func recordReflectionSaved(ctx context.Context, reflectionType string) {
	ensureReflectionMetrics()

	if reflectionsSaved == nil {
		return
	}

	typ := reflectionType
	if typ == "" {
		typ = "(unspecified)"
	}

	reflectionsSaved.Add(ctx, 1, metric.WithAttributes(attribute.String("reflection_type", typ)))
}

func recordReflectionsRetrieved(ctx context.Context, count int) {
	ensureReflectionMetrics()

	if reflectionsRetrieved == nil {
		return
	}

	if count < 0 {
		count = 0
	}

	reflectionsRetrieved.Add(ctx, int64(count), metric.WithAttributes(attribute.Int("results", count)))
}
