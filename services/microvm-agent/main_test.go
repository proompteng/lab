package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCollectEvidenceHashesBootstrapToken(t *testing.T) {
	t.Parallel()

	const token = "do-not-log-this-bootstrap-token"
	startedAt := time.Date(2026, time.August, 23, 12, 0, 0, 0, time.UTC)
	readFile := func(path string) ([]byte, error) {
		switch path {
		case bootIDPath:
			return []byte("guest-boot-id\n"), nil
		case kernelReleasePath:
			return []byte("6.18.35\n"), nil
		default:
			return nil, errors.New("unexpected path")
		}
	}

	got, err := collectEvidence("firecracker-canary", token, readFile, startedAt)
	if err != nil {
		t.Fatalf("collectEvidence() error = %v", err)
	}
	if got.BootID != "guest-boot-id" || got.KernelRelease != "6.18.35" {
		t.Fatalf("collectEvidence() = %#v", got)
	}
	if got.BootstrapTokenSHA256 == "" || got.BootstrapTokenSHA256 == token {
		t.Fatalf("bootstrap hash = %q", got.BootstrapTokenSHA256)
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if strings.Contains(string(encoded), token) {
		t.Fatalf("evidence leaked bootstrap token: %s", encoded)
	}
}

func TestCollectEvidenceRequiresBootstrapInputs(t *testing.T) {
	t.Parallel()

	readFile := func(string) ([]byte, error) { return nil, errors.New("must not be called") }
	if _, err := collectEvidence("", "token", readFile, time.Time{}); err == nil {
		t.Fatal("collectEvidence() accepted an empty microVM ID")
	}
	if _, err := collectEvidence("id", "", readFile, time.Time{}); err == nil {
		t.Fatal("collectEvidence() accepted an empty bootstrap token")
	}
}

func TestEvidenceHandler(t *testing.T) {
	t.Parallel()

	want := evidence{MicroVMID: "firecracker-canary", State: "ready"}
	request := httptest.NewRequest(http.MethodGet, "/evidence", nil)
	response := httptest.NewRecorder()

	newHandler(want).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var got evidence
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got != want {
		t.Fatalf("evidence = %#v, want %#v", got, want)
	}
}

func TestHealthHandler(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	newHandler(evidence{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "{\"status\":\"ok\"}\n" {
		t.Fatalf("response = status %d body %q", response.Code, response.Body.String())
	}
}
