package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

type requestMeta struct {
	model     string
	endpoint  string
	stream    bool
	startTime time.Time
}

type metricSet struct {
	requests      metric.Int64Counter
	errors        metric.Int64Counter
	inflight      metric.Int64UpDownCounter
	durationMs    metric.Float64Histogram
	promptTok     metric.Int64Counter
	completionTok metric.Int64Counter
	totalTok      metric.Int64Counter
	tpsHist       metric.Float64Histogram
}

func main() {
	listenAddr := envOrDefault("OLLAMA_PROXY_LISTEN", ":11434")
	upstream := envOrDefault("OLLAMA_PROXY_UPSTREAM", "http://127.0.0.1:11435")
	serviceName := envOrDefault("OTEL_SERVICE_NAME", "ollama-proxy")
	otlpEndpoint := envOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")

	flag.Parse()

	ctx := context.Background()
	tp, mp, shutdown := setupOTel(ctx, serviceName, otlpEndpoint)
	defer shutdown()

	tracer := tp.Tracer("ollama-proxy")
	meter := mp.Meter("ollama-proxy")

	metrics := initMetrics(meter)

	upstreamURL, err := url.Parse(upstream)
	if err != nil {
		log.Fatalf("invalid upstream URL: %v", err)
	}

	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	proxy.Transport = otelhttp.NewTransport(&http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          200,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	})

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meta := &requestMeta{
			endpoint:  r.URL.Path,
			startTime: time.Now(),
		}

		bodyBytes, err := readBody(r)
		if err != nil {
			http.Error(w, "failed to read request", http.StatusBadRequest)
			return
		}
		if len(bodyBytes) > 0 {
			parseRequestMeta(bodyBytes, meta)
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		}

		attrs := []attribute.KeyValue{attribute.String("endpoint", meta.endpoint)}
		if meta.model != "" {
			attrs = append(attrs, attribute.String("model", meta.model))
		}

		metrics.inflight.Add(r.Context(), 1, metric.WithAttributes(attrs...))
		defer metrics.inflight.Add(r.Context(), -1, metric.WithAttributes(attrs...))

		spanCtx, span := tracer.Start(r.Context(), fmt.Sprintf("%s %s", r.Method, r.URL.Path))
		defer span.End()

		rr := &responseRecorder{ResponseWriter: w, status: http.StatusOK}

		var finalizeOnce sync.Once
		finalize := func(result *ollamaResult) {
			finalizeOnce.Do(func() {
				duration := time.Since(meta.startTime)
				metrics.requests.Add(spanCtx, 1, metric.WithAttributes(attrs...))
				metrics.durationMs.Record(spanCtx, float64(duration.Milliseconds()), metric.WithAttributes(attrs...))
				if rr.status >= 400 {
					metrics.errors.Add(spanCtx, 1, metric.WithAttributes(attrs...))
				}
				if result != nil {
					resultAttrs := append(attrs, attribute.String("model", result.Model))
					if result.PromptTokens > 0 {
						metrics.promptTok.Add(spanCtx, int64(result.PromptTokens), metric.WithAttributes(resultAttrs...))
					}
					if result.CompletionTokens > 0 {
						metrics.completionTok.Add(spanCtx, int64(result.CompletionTokens), metric.WithAttributes(resultAttrs...))
					}
					if result.TotalTokens > 0 {
						metrics.totalTok.Add(spanCtx, int64(result.TotalTokens), metric.WithAttributes(resultAttrs...))
					}
					if result.TokensPerSecond > 0 {
						metrics.tpsHist.Record(spanCtx, result.TokensPerSecond, metric.WithAttributes(resultAttrs...))
					}
				}
			})
		}

		requestProxy := *proxy
		requestProxy.ModifyResponse = func(resp *http.Response) error {
			if resp == nil || resp.Body == nil {
				finalize(nil)
				return nil
			}
			result := &ollamaResult{Model: meta.model}
			resp.Body = wrapResponseBody(resp.Body, meta, result, finalize)
			return nil
		}

		requestProxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, e error) {
			rr.status = http.StatusBadGateway
			finalize(nil)
			http.Error(rw, "upstream error", http.StatusBadGateway)
		}

		requestProxy.ServeHTTP(rr, r.WithContext(spanCtx))
	})

	server := &http.Server{
		Addr:    listenAddr,
		Handler: otelhttp.NewHandler(handler, "ollama-proxy"),
	}

	log.Printf("listening on %s -> %s", listenAddr, upstream)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *responseRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

type ollamaResult struct {
	Model            string
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	TokensPerSecond  float64
}

type resultParser struct {
	meta   *requestMeta
	result *ollamaResult
	buffer bytes.Buffer
	done   bool
}

func wrapResponseBody(body io.ReadCloser, meta *requestMeta, result *ollamaResult, finalize func(*ollamaResult)) io.ReadCloser {
	if meta == nil {
		return &readCloserWrapper{ReadCloser: body, onClose: func() { finalize(nil) }}
	}
	parser := &resultParser{meta: meta, result: result}
	return &teeReadCloser{
		ReadCloser: body,
		onRead: func(p []byte) {
			parser.ingest(p)
		},
		onClose: func() {
			if !parser.done {
				parser.finalizeFromBuffer()
			}
			if result.Model == "" {
				result.Model = meta.model
			}
			finalize(result)
		},
	}
}

type teeReadCloser struct {
	io.ReadCloser
	onRead  func([]byte)
	onClose func()
}

func (t *teeReadCloser) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	if n > 0 && t.onRead != nil {
		t.onRead(p[:n])
	}
	if err == io.EOF {
		if t.onClose != nil {
			t.onClose()
		}
	}
	return n, err
}

func (t *teeReadCloser) Close() error {
	if t.onClose != nil {
		t.onClose()
	}
	return t.ReadCloser.Close()
}

type readCloserWrapper struct {
	io.ReadCloser
	onClose func()
}

func (r *readCloserWrapper) Close() error {
	if r.onClose != nil {
		r.onClose()
	}
	return r.ReadCloser.Close()
}

func (p *resultParser) ingest(chunk []byte) {
	p.buffer.Write(chunk)
	if p.meta == nil {
		return
	}
	if p.meta.stream {
		p.parseStreamed()
	}
}

func (p *resultParser) parseStreamed() {
	data := p.buffer.String()
	lines := strings.Split(data, "\n")
	if len(lines) < 2 {
		return
	}
	for i := 0; i < len(lines)-1; i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		p.parseLine(line)
	}
	p.buffer.Reset()
	p.buffer.WriteString(lines[len(lines)-1])
}

func (p *resultParser) parseLine(line string) {
	// Handle SSE format: "data: {json}" or "data: [DONE]"
	if strings.HasPrefix(line, "data:") {
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			p.done = true
			return
		}
		p.consumeJSON([]byte(payload))
		return
	}
	p.consumeJSON([]byte(line))
}

func (p *resultParser) consumeJSON(data []byte) {
	if len(data) == 0 {
		return
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return
	}
	p.extractFromRaw(raw)
}

func (p *resultParser) finalizeFromBuffer() {
	if p.buffer.Len() == 0 {
		return
	}
	p.consumeJSON(p.buffer.Bytes())
}

func (p *resultParser) extractFromRaw(raw map[string]any) {
	if p.result == nil {
		return
	}
	// /api/generate or /api/chat
	if model, ok := raw["model"].(string); ok && model != "" {
		p.result.Model = model
	}
	if done, ok := raw["done"].(bool); ok && done {
		p.done = true
	}
	if evalCount, ok := toInt(raw["eval_count"]); ok {
		p.result.CompletionTokens = evalCount
	}
	if promptCount, ok := toInt(raw["prompt_eval_count"]); ok {
		p.result.PromptTokens = promptCount
	}
	if p.result.CompletionTokens > 0 || p.result.PromptTokens > 0 {
		p.result.TotalTokens = p.result.CompletionTokens + p.result.PromptTokens
	}
	evalDurNs, _ := toInt(raw["eval_duration"])
	if evalDurNs > 0 && p.result.CompletionTokens > 0 {
		p.result.TokensPerSecond = float64(p.result.CompletionTokens) / (float64(evalDurNs) / 1e9)
	}
	// OpenAI compatible responses
	if usage, ok := raw["usage"].(map[string]any); ok {
		if prompt, ok := toInt(usage["prompt_tokens"]); ok {
			p.result.PromptTokens = prompt
		}
		if completion, ok := toInt(usage["completion_tokens"]); ok {
			p.result.CompletionTokens = completion
		}
		if total, ok := toInt(usage["total_tokens"]); ok {
			p.result.TotalTokens = total
		}
		if p.result.TotalTokens > 0 && p.meta != nil {
			duration := time.Since(p.meta.startTime).Seconds()
			if duration > 0 {
				p.result.TokensPerSecond = float64(p.result.TotalTokens) / duration
			}
		}
	}
}

func toInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case json.Number:
		i, err := t.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	default:
		return 0, false
	}
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func parseRequestMeta(body []byte, meta *requestMeta) {
	if meta == nil {
		return
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return
	}
	if model, ok := raw["model"].(string); ok {
		meta.model = model
	}
	if streamVal, ok := raw["stream"].(bool); ok {
		meta.stream = streamVal
	}
	// OpenAI style: stream=true may be string? default false
	if meta.endpoint == "" {
		meta.endpoint = "/"
	}
}

func initMetrics(meter metric.Meter) metricSet {
	requests, _ := meter.Int64Counter("ollama_requests_total")
	errors, _ := meter.Int64Counter("ollama_request_errors_total")
	inflight, _ := meter.Int64UpDownCounter("ollama_requests_inflight")
	durationMs, _ := meter.Float64Histogram("ollama_request_duration_ms")
	promptTok, _ := meter.Int64Counter("ollama_prompt_tokens_total")
	completionTok, _ := meter.Int64Counter("ollama_completion_tokens_total")
	totalTok, _ := meter.Int64Counter("ollama_total_tokens_total")
	tpsHist, _ := meter.Float64Histogram("ollama_tokens_per_second")
	return metricSet{
		requests:      requests,
		errors:        errors,
		inflight:      inflight,
		durationMs:    durationMs,
		promptTok:     promptTok,
		completionTok: completionTok,
		totalTok:      totalTok,
		tpsHist:       tpsHist,
	}
}

func setupOTel(ctx context.Context, serviceName, endpoint string) (*sdktrace.TracerProvider, metric.MeterProvider, func()) {
	res, _ := resource.New(ctx,
		resource.WithAttributes(
			attribute.String("service.name", serviceName),
		),
	)

	otlpEndpoint, otlpPath, otlpInsecure, err := parseOTLPEndpoint(endpoint)
	if err != nil {
		log.Fatalf("invalid OTLP endpoint: %v", err)
	}

	traceOpts := []otlptracehttp.Option{otlptracehttp.WithEndpoint(otlpEndpoint)}
	if otlpPath != "" {
		traceOpts = append(traceOpts, otlptracehttp.WithURLPath(otlpPath))
	}
	if otlpInsecure {
		traceOpts = append(traceOpts, otlptracehttp.WithInsecure())
	}
	traceExp, err := otlptracehttp.New(ctx, traceOpts...)
	if err != nil {
		log.Fatalf("trace exporter: %v", err)
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)

	metricOpts := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpoint(otlpEndpoint)}
	if otlpPath != "" {
		metricOpts = append(metricOpts, otlpmetrichttp.WithURLPath(otlpPath))
	}
	if otlpInsecure {
		metricOpts = append(metricOpts, otlpmetrichttp.WithInsecure())
	}
	metricExp, err := otlpmetrichttp.New(ctx, metricOpts...)
	if err != nil {
		log.Fatalf("metric exporter: %v", err)
	}
	reader := sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(10*time.Second))
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(reader),
		sdkmetric.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)

	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tp.Shutdown(ctx)
		_ = mp.Shutdown(ctx)
	}

	return tp, mp, shutdown
}

func parseOTLPEndpoint(endpoint string) (string, string, bool, error) {
	if strings.Contains(endpoint, "://") {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return "", "", false, err
		}
		if parsed.Host == "" {
			return "", "", false, fmt.Errorf("missing host in %q", endpoint)
		}
		insecure := parsed.Scheme == "http"
		path := strings.TrimSpace(parsed.Path)
		if path == "/" {
			path = ""
		}
		return parsed.Host, path, insecure, nil
	}

	if endpoint == "" {
		return "", "", false, fmt.Errorf("endpoint is empty")
	}
	return endpoint, "", true, nil
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
