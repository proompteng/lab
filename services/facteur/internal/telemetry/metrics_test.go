package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestRecordCommandProcessed(t *testing.T) {
	resetCommandMetrics()

	ctx := context.Background()
	reader := setupTestMeterProvider(t)

	RecordCommandProcessed(ctx, "plan", 42*time.Millisecond)

	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(ctx, &rm))
	require.Len(t, rm.ScopeMetrics, 1)

	metrics := rm.ScopeMetrics[0].Metrics
	require.GreaterOrEqual(t, len(metrics), 2)

	sumMetric := mustFindMetric(t, metrics, "facteur_command_events_processed_total")
	sumData, ok := sumMetric.Data.(metricdata.Sum[int64])
	require.True(t, ok)
	require.Len(t, sumData.DataPoints, 1)

	sumPoint := sumData.DataPoints[0]
	require.Equal(t, int64(1), sumPoint.Value)
	require.Equal(t, []attribute.KeyValue{attribute.String("command", "plan")}, sumPoint.Attributes.ToSlice())

	histMetric := mustFindMetric(t, metrics, "facteur_command_events_duration_ms")
	histData, ok := histMetric.Data.(metricdata.Histogram[float64])
	require.True(t, ok)
	require.Len(t, histData.DataPoints, 1)

	histPoint := histData.DataPoints[0]
	require.Equal(t, uint64(1), histPoint.Count)
	require.InEpsilon(t, 42.0, histPoint.Sum, 0.001)
	require.Equal(t, []attribute.KeyValue{attribute.String("command", "plan")}, histPoint.Attributes.ToSlice())
}

func TestRecordCommandFailedAndDLQ(t *testing.T) {
	resetCommandMetrics()

	ctx := context.Background()
	reader := setupTestMeterProvider(t)

	RecordCommandFailed(ctx, "review")
	RecordCommandDLQ(ctx, "review")

	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(ctx, &rm))
	require.Len(t, rm.ScopeMetrics, 1)

	metrics := rm.ScopeMetrics[0].Metrics
	require.GreaterOrEqual(t, len(metrics), 2)

	failedMetric := mustFindMetric(t, metrics, "facteur_command_events_failed_total")
	failedData, ok := failedMetric.Data.(metricdata.Sum[int64])
	require.True(t, ok)
	require.Len(t, failedData.DataPoints, 1)

	failedPoint := failedData.DataPoints[0]
	require.Equal(t, int64(1), failedPoint.Value)
	require.Equal(t, []attribute.KeyValue{attribute.String("command", "review")}, failedPoint.Attributes.ToSlice())

	dlqMetric := mustFindMetric(t, metrics, "facteur_command_events_dlq_total")
	dlqData, ok := dlqMetric.Data.(metricdata.Sum[int64])
	require.True(t, ok)
	require.Len(t, dlqData.DataPoints, 1)

	dlqPoint := dlqData.DataPoints[0]
	require.Equal(t, int64(1), dlqPoint.Value)
	require.Equal(t, []attribute.KeyValue{attribute.String("command", "review")}, dlqPoint.Attributes.ToSlice())
}

func setupTestMeterProvider(t *testing.T) *sdkmetric.ManualReader {
	t.Helper()

	resetCommandMetrics()

	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))

	prev := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(prev)
		resetCommandMetrics()
	})

	return reader
}

func mustFindMetric(t *testing.T, metrics []metricdata.Metrics, name string) metricdata.Metrics {
	t.Helper()

	for _, m := range metrics {
		if m.Name == name {
			return m
		}
	}
	t.Fatalf("metric %s not found", name)
	return metricdata.Metrics{}
}
