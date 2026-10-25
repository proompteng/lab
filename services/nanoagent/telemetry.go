package main

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/felixge/httpsnoop"
	"github.com/getsentry/sentry-go"
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func initializeTelemetry(component string) (func(), error) {
	if err := sentry.Init(sentry.ClientOptions{
		Dsn: os.Getenv("SENTRY_DSN"), Release: os.Getenv("APP_SOURCE_REVISION"),
		Environment: "production", MaxBreadcrumbs: -1, BeforeSend: sanitizeGuestError,
	}); err != nil {
		return nil, err
	}
	sentry.ConfigureScope(func(scope *sentry.Scope) { scope.SetTag("component", component) })
	otel.SetTextMapPropagator(propagation.TraceContext{})
	var provider *sdktrace.TracerProvider
	if endpoint := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"); endpoint != "" {
		exporter, err := otlptracehttp.New(context.Background(), otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithTimeout(3*time.Second))
		if err != nil {
			return nil, err
		}
		provider = sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter, sdktrace.WithMaxQueueSize(2048), sdktrace.WithExportTimeout(3*time.Second)),
			sdktrace.WithResource(resource.NewSchemaless(
				attribute.String("service.name", "nanoagent"),
				attribute.String("service.namespace", "tengri"),
				attribute.String("tengri.component", component),
				attribute.String("service.version", os.Getenv("APP_SOURCE_REVISION")),
				attribute.String("deployment.environment.name", "production"),
			)),
		)
		otel.SetTracerProvider(provider)
	}
	return func() {
		if provider != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = provider.Shutdown(ctx)
		}
		sentry.Flush(3 * time.Second)
	}, nil
}

func sanitizeGuestError(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	event.Request, event.Contexts, event.Breadcrumbs = nil, nil, nil
	event.Attachments, event.Threads, event.DebugMeta = nil, nil, nil
	event.ServerName, event.Transaction = "", ""
	event.User = sentry.User{}
	event.Message = "Application operation failed; inspect the correlated trace"
	for i := range event.Exception {
		event.Exception[i].Value = "Runtime message withheld"
		if stack := event.Exception[i].Stacktrace; stack != nil {
			for j := range stack.Frames {
				frame := &stack.Frames[j]
				frame.Vars, frame.PreContext, frame.PostContext = nil, nil, nil
				frame.ContextLine = ""
			}
		}
	}
	return event
}

func reportGuestError(ctx context.Context, operation, code string) {
	span := trace.SpanFromContext(ctx)
	span.SetStatus(otelcodes.Error, code)
	event := sentry.NewEvent()
	event.Level = sentry.LevelError
	event.Tags = map[string]string{"service": "nanoagent", "operation": operation, "code": code}
	if span.SpanContext().IsValid() {
		event.Tags["trace_id"] = span.SpanContext().TraceID().String()
	}
	event.Exception = []sentry.Exception{{Type: "GuestOperationError", Stacktrace: sentry.NewStacktrace()}}
	sentry.CaptureEvent(event)
}

func recordGuestRPC(ctx context.Context, method string, err error) {
	code := status.Code(err)
	trace.SpanFromContext(ctx).SetAttributes(attribute.Int("rpc.grpc.status_code", int(code)))
	if code == codes.Internal || code == codes.Unavailable || code == codes.DeadlineExceeded || code == codes.Unknown {
		reportGuestError(ctx, method, code.String())
	}
}

func guestOperation(path string) string {
	prefix := "/" + pb.NanoagentService_ServiceDesc.ServiceName + "/"
	if method, ok := strings.CutPrefix(path, prefix); ok {
		for _, descriptor := range pb.NanoagentService_ServiceDesc.Methods {
			if method == descriptor.MethodName {
				return prefix + method
			}
		}
		for _, descriptor := range pb.NanoagentService_ServiceDesc.Streams {
			if method == descriptor.StreamName {
				return prefix + method
			}
		}
	}
	if strings.HasPrefix(path, "/v1/preview/") {
		return "guest.preview"
	}
	return "guest.http"
}

func observeGuestHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		operation := guestOperation(r.URL.Path)
		parent := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer("nanoagent").Start(parent, operation, trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()
		if span.SpanContext().IsValid() {
			w.Header().Set("X-Trace-Id", span.SpanContext().TraceID().String())
		}
		metrics := httpsnoop.CaptureMetrics(next, w, r.WithContext(ctx))
		span.SetAttributes(attribute.Int("http.response.status_code", metrics.Code))
		if metrics.Code >= 500 {
			span.SetStatus(otelcodes.Error, http.StatusText(metrics.Code))
			if r.URL.Path != "/readyz" && r.URL.Path != "/healthz" && r.URL.Path != "/livez" {
				reportGuestError(ctx, operation, http.StatusText(metrics.Code))
			}
		}
	})
}
