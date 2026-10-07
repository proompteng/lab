package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRelayStdioPreservesIDsAndDropsNotificationResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		if request["id"] == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"tools": []any{}}})
	}))
	defer server.Close()
	var output bytes.Buffer
	err := relayStdio(strings.NewReader("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":\"test\",\"method\":\"tools/list\"}\n"), &output, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &result); err != nil || result["id"] != "test" {
		t.Fatalf("invalid result: %s, %v", output.Bytes(), err)
	}
}

func TestRelayStdioFailsClosedOnProviderErrorsAndMismatchedIDs(t *testing.T) {
	for _, body := range []string{"private provider error including secret", `{"jsonrpc":"2.0","id":999,"result":{}}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }))
		var output bytes.Buffer
		err := relayStdio(strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n"), &output, server.Client(), server.URL)
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(output.String(), "Relay transport unavailable") || strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "999") {
			t.Fatalf("unexpected result: %s", output.String())
		}
	}
}
