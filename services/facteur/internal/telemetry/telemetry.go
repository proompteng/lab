package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	instrumentationName = "github.com/proompteng/lab/services/facteur"
	defaultServiceName  = "facteur"
	defaultOTLPProtocol = "http/protobuf"
)

var (
	setupOnce  sync.Once
	setupErr   error
	shutdownFn func(context.Context) error
)

// Setup configures OpenTelemetry exporters for traces and metrics. It returns a
// shutdown function that should be invoked during service teardown.
func Setup(ctx context.Context, serviceName string, protocol string) (func(context.Context) error, error) {
	setupOnce.Do(func() {
		if serviceName == "" {
			serviceName = defaultServiceName
		}
		if protocol == "" {
			protocol = defaultOTLPProtocol
		}

		if os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL") == "" && protocol != "" {
			if err := os.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", protocol); err != nil {
				setupErr = fmt.Errorf("set OTLP protocol: %w", err)
				return
			}
		}

		res, err := resource.New(ctx,
			resource.WithFromEnv(),
			resource.WithProcess(),
			resource.WithHost(),
			resource.WithTelemetrySDK(),
			resource.WithAttributes(
				semconv.ServiceName(serviceName),
			),
		)
		if err != nil {
			setupErr = fmt.Errorf("build resource: %w", err)
			return
		}

		traceExp, err := otlptracehttp.New(ctx)
		if err != nil {
			setupErr = fmt.Errorf("create trace exporter: %w", err)
			return
		}

		tracerProvider := sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(traceExp),
			sdktrace.WithResource(res),
		)

		metricExp, err := otlpmetrichttp.New(ctx)
		if err != nil {
			setupErr = fmt.Errorf("create metric exporter: %w", err)
			return
		}

		metricReader := sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))
		meterProvider := sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(metricReader),
		)

		otel.SetTracerProvider(tracerProvider)
		otel.SetMeterProvider(meterProvider)
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		))

		shutdownFn = func(ctx context.Context) error {
			var combined error
			combined = errors.Join(combined, meterProvider.Shutdown(ctx))
			combined = errors.Join(combined, tracerProvider.Shutdown(ctx))
			return combined
		}
	})

	if setupErr != nil {
		return nil, setupErr
	}

	if shutdownFn == nil {
		return func(context.Context) error { return nil }, nil
	}

	return shutdownFn, nil
}

// ForceFlush requests both tracer and meter providers to flush outstanding spans
// or metrics before process termination.
func ForceFlush(ctx context.Context) error {
	tracerProvider := otel.GetTracerProvider()
	meterProvider := otel.GetMeterProvider()

	var combined error
	if tp, ok := tracerProvider.(*sdktrace.TracerProvider); ok {
		combined = errors.Join(combined, tp.ForceFlush(ctx))
	}
	if mp, ok := meterProvider.(*sdkmetric.MeterProvider); ok {
		combined = errors.Join(combined, mp.ForceFlush(ctx))
	}
	return combined
}

// Tracer returns the service-wide tracer instance.
func Tracer() trace.Tracer {
	return otel.Tracer(instrumentationName)
}

// Meter returns the service-wide meter instance.
func Meter() metric.Meter {
	return otel.Meter(instrumentationName)
}
