package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type responseBody map[string]any

func performRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func decode(t *testing.T, resp *httptest.ResponseRecorder) responseBody {
	t.Helper()
	var decoded responseBody
	if err := json.Unmarshal(resp.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	return decoded
}

func TestRootHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newRouter()

	resp := performRequest(router, http.MethodGet, "/", "")
	if resp.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.Code)
	}

	payload := decode(t, resp)
	if payload["status"] != "OK" {
		t.Fatalf("expected status OK, got %v", payload["status"])
	}
}

func TestHandleData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newRouter()

	t.Run("valid payload", func(t *testing.T) {
		resp := performRequest(router, http.MethodPost, "/data", `{"data":"demo"}`)
		if resp.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", resp.Code)
		}

		payload := decode(t, resp)
		if payload["received_data"] != "demo" {
			t.Fatalf("expected received_data demo, got %v", payload["received_data"])
		}
	})

	t.Run("invalid payload", func(t *testing.T) {
		resp := performRequest(router, http.MethodPost, "/data", `{"data":}`)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", resp.Code)
		}
	})
}

func TestHealthEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newRouter()

	tests := []struct {
		name     string
		path     string
		expected string
	}{
		{"healthz", "/healthz", "healthy"},
		{"liveness", "/health/liveness", "alive"},
		{"readiness", "/health/readiness", "ready"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := performRequest(router, http.MethodGet, tc.path, "")
			if resp.Code != http.StatusOK {
				t.Fatalf("expected status 200, got %d", resp.Code)
			}

			payload := decode(t, resp)
			if payload["status"] != tc.expected {
				t.Fatalf("expected status %s, got %v", tc.expected, payload["status"])
			}
		})
	}
}
