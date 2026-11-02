package main

import (
	"encoding/json"
	"io"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseRequestMeta(t *testing.T) {
	meta := &requestMeta{}
	body := []byte(`{"model":"qwen","stream":true}`)
	parseRequestMeta(body, meta)

	if meta.model != "qwen" {
		t.Fatalf("expected model qwen, got %q", meta.model)
	}
	if !meta.stream {
		t.Fatalf("expected stream true")
	}
	if meta.endpoint != "/" {
		t.Fatalf("expected default endpoint '/', got %q", meta.endpoint)
	}
}

func TestToInt(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  int
		ok    bool
	}{
		{"float64", float64(3), 3, true},
		{"int", int(4), 4, true},
		{"int64", int64(5), 5, true},
		{"jsonNumber", json.Number("6"), 6, true},
		{"jsonNumberInvalid", json.Number("nope"), 0, false},
		{"string", "7", 0, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toInt(tc.value)
			if ok != tc.ok {
				t.Fatalf("expected ok %v, got %v", tc.ok, ok)
			}
			if ok && got != tc.want {
				t.Fatalf("expected %d, got %d", tc.want, got)
			}
		})
	}
}

func TestResultParserStreamedSSE(t *testing.T) {
	meta := &requestMeta{stream: true, startTime: time.Now()}
	result := &ollamaResult{}
	parser := &resultParser{meta: meta, result: result}

	payload := strings.Join([]string{
		`data: {"model":"m1","eval_count":4,"prompt_eval_count":2,"eval_duration":1000000000}`,
		`data: {"done":true}`,
		`data: [DONE]`,
		"",
	}, "\n")

	parser.ingest([]byte(payload))

	if result.Model != "m1" {
		t.Fatalf("expected model m1, got %q", result.Model)
	}
	if result.CompletionTokens != 4 {
		t.Fatalf("expected completion 4, got %d", result.CompletionTokens)
	}
	if result.PromptTokens != 2 {
		t.Fatalf("expected prompt 2, got %d", result.PromptTokens)
	}
	if result.TotalTokens != 6 {
		t.Fatalf("expected total 6, got %d", result.TotalTokens)
	}
	if !parser.done {
		t.Fatalf("expected parser done true")
	}
	if math.Abs(result.TokensPerSecond-4) > 0.01 {
		t.Fatalf("expected tps about 4, got %f", result.TokensPerSecond)
	}
}

func TestWrapResponseBodyNonStreamFinalize(t *testing.T) {
	meta := &requestMeta{stream: false, startTime: time.Now()}
	result := &ollamaResult{}
	body := io.NopCloser(strings.NewReader(`{"model":"m2","eval_count":3,"prompt_eval_count":1,"eval_duration":1000000000}`))

	var calls int32
	var once sync.Once
	finalize := func(res *ollamaResult) {
		once.Do(func() {
			atomic.AddInt32(&calls, 1)
			if res == nil {
				t.Fatalf("expected result, got nil")
			}
		})
	}

	wrapped := wrapResponseBody(body, meta, result, finalize)
	_, err := io.ReadAll(wrapped)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	_ = wrapped.Close()

	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected finalize called once, got %d", calls)
	}
	if result.Model != "m2" {
		t.Fatalf("expected model m2, got %q", result.Model)
	}
	if result.TotalTokens != 4 {
		t.Fatalf("expected total 4, got %d", result.TotalTokens)
	}
}

func TestWrapResponseBodyNilMeta(t *testing.T) {
	body := io.NopCloser(strings.NewReader("{}"))

	var called int32
	finalize := func(res *ollamaResult) {
		if res != nil {
			t.Fatalf("expected nil result")
		}
		atomic.AddInt32(&called, 1)
	}

	wrapped := wrapResponseBody(body, nil, nil, finalize)
	_ = wrapped.Close()

	if atomic.LoadInt32(&called) != 1 {
		t.Fatalf("expected finalize called once, got %d", called)
	}
}

func TestParseOTLPEndpoint(t *testing.T) {
	cases := []struct {
		name      string
		endpoint  string
		wantHost  string
		wantPath  string
		wantInsec bool
		wantErr   bool
	}{
		{"http", "http://collector:4318", "collector:4318", "", true, false},
		{"https", "https://collector:4318", "collector:4318", "", false, false},
		{"httpsPath", "https://collector:4318/otlp", "collector:4318", "/otlp", false, false},
		{"plain", "collector:4318", "collector:4318", "", true, false},
		{"empty", "", "", "", false, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host, path, insecure, err := parseOTLPEndpoint(tc.endpoint)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if host != tc.wantHost {
				t.Fatalf("expected host %q, got %q", tc.wantHost, host)
			}
			if path != tc.wantPath {
				t.Fatalf("expected path %q, got %q", tc.wantPath, path)
			}
			if insecure != tc.wantInsec {
				t.Fatalf("expected insecure %v, got %v", tc.wantInsec, insecure)
			}
		})
	}
}
