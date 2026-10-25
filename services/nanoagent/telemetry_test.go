package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace/noop"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestGuestTelemetryExportsJoinedSpanAndScrubbedError(t *testing.T) {
	var lock sync.Mutex
	var exported collector.ExportTraceServiceRequest
	var errors []string
	ingest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		lock.Lock()
		defer lock.Unlock()
		if r.URL.Path == "/v1/traces" {
			if err := proto.Unmarshal(body, &exported); err != nil {
				t.Error(err)
			}
			w.Header().Set("Content-Type", "application/x-protobuf")
		} else {
			errors = append(errors, string(body))
		}
	}))
	defer ingest.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", ingest.URL+"/v1/traces")
	t.Setenv("SENTRY_DSN", strings.Replace(ingest.URL, "://", "://0123456789abcdef0123456789abcdef@", 1)+"/1")
	t.Setenv("APP_SOURCE_REVISION", strings.Repeat("a", 40))
	closeTelemetry, err := initializeTelemetry("api")
	if err != nil {
		t.Fatal(err)
	}
	defer otel.SetTracerProvider(noop.NewTracerProvider())
	request := httptest.NewRequest(http.MethodGet, "/v1/preview/1234/private-file?secret=PRIVATE_SENTINEL", nil)
	request.Header.Set("Cookie", "credential=PRIVATE_SENTINEL")
	request.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	observeGuestHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "PRIVATE_SENTINEL", http.StatusBadGateway)
	})).ServeHTTP(httptest.NewRecorder(), request)
	for _, path := range []string{"/readyz", "/healthz"} {
		observeGuestHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	closeTelemetry()
	lock.Lock()
	defer lock.Unlock()
	if len(exported.ResourceSpans) != 1 {
		t.Fatalf("no OTLP resource: %v", exported.ResourceSpans)
	}
	spans := exported.ResourceSpans[0].ScopeSpans[0].Spans
	if len(spans) != 3 || spans[0].Name != "guest.preview" || string(spans[0].TraceId) != strings.Repeat("\x11", 16) || string(spans[0].ParentSpanId) != strings.Repeat("\x22", 8) {
		t.Fatalf("trace parent or safe operation lost: %v", spans)
	}
	if len(errors) != 1 || !strings.Contains(errors[0], "11111111111111111111111111111111") || strings.Contains(errors[0], "PRIVATE_SENTINEL") {
		t.Fatalf("error export missing correlation or leaked content: count=%d", len(errors))
	}
	if !strings.Contains(errors[0], `"component":"api"`) || !strings.Contains(exported.String(), "tengri.component") {
		t.Fatal("guest component identity is missing from telemetry")
	}
	for _, span := range spans {
		if span.Status.GetCode() != tracepb.Status_STATUS_CODE_ERROR {
			t.Fatal("HTTP failure lost its failed trace status")
		}
	}
	if strings.Contains(exported.String(), "PRIVATE_SENTINEL") || strings.Contains(exported.String(), "private-file") {
		t.Fatal("trace leaked request content")
	}
}

func TestGuestTelemetryPreservesWebSocketUpgrade(t *testing.T) {
	server := httptest.NewServer(observeGuestHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		kind, bytes, err := connection.Read(r.Context())
		if err == nil {
			err = connection.Write(r.Context(), kind, bytes)
		}
		if err != nil {
			t.Error(err)
		}
	})))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http:", "ws:", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if err := connection.Write(ctx, websocket.MessageText, []byte("terminal-ok")); err != nil {
		t.Fatal(err)
	}
	_, bytes, err := connection.Read(ctx)
	if err != nil || string(bytes) != "terminal-ok" {
		t.Fatalf("WebSocket transport changed: %s %v", bytes, err)
	}
}

func TestGuestTelemetryPreservesFlushing(t *testing.T) {
	flushed := false
	observeGuestHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("telemetry hid the stream flusher")
		}
		flusher.Flush()
		flushed = true
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !flushed {
		t.Fatal("stream did not flush")
	}
}
