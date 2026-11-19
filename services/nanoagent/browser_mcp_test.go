package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func browserMCPRequest(t *testing.T, browser *browserSupervisor, session, payload string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://preview/mcp", strings.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	if session != "" {
		request.Header.Set("Mcp-Session-Id", session)
	}
	response := httptest.NewRecorder()
	browser.serve(response, request, "/mcp")
	return response
}

func initializeBrowserMCP(t *testing.T, browser *browserSupervisor) string {
	t.Helper()
	response := browserMCPRequest(t, browser, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	session := response.Header().Get("Mcp-Session-Id")
	if response.Code != http.StatusOK || !browserDriverPattern.MatchString(session) {
		t.Fatalf("MCP initialization failed: %d %s", response.Code, response.Body.String())
	}
	return session
}

func TestBrowserHTTPMCPUsesTheSharedComputerAndHonorsTakeover(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	first := initializeBrowserMCP(t, browser)
	second := initializeBrowserMCP(t, browser)
	response := browserMCPRequest(t, browser, first, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte(`"name":"computer"`)) {
		t.Fatalf("the existing computer tool is missing: %d %s", response.Code, response.Body.String())
	}
	browser.cuaMu.Lock()
	if err := browser.claimDriver(first); err != nil {
		t.Fatal(err)
	}
	browser.cuaMu.Unlock()
	response = browserMCPRequest(t, browser, second, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"computer","arguments":{"action":"screenshot"}}}`)
	if !bytes.Contains(response.Body.Bytes(), []byte(`"isError":true`)) || !bytes.Contains(response.Body.Bytes(), []byte("Another agent")) || browser.current != nil {
		t.Fatalf("a competing MCP client reached the browser: %s", response.Body.String())
	}
	browser.cuaMu.Lock()
	browser.userControl = true
	browser.driver = browserDriver{}
	browser.cuaMu.Unlock()
	response = browserMCPRequest(t, browser, first, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"computer","arguments":{"action":"screenshot"}}}`)
	if !bytes.Contains(response.Body.Bytes(), []byte("taken control")) || browser.current != nil {
		t.Fatalf("human takeover did not pause HTTP MCP screenshots: %s", response.Body.String())
	}
	response = browserMCPRequest(t, browser, first, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"computer","arguments":{"action":"status"}}}`)
	if !bytes.Contains(response.Body.Bytes(), []byte(`"userControl":true`)) {
		t.Fatalf("status must remain available during takeover: %s", response.Body.String())
	}
}

func TestBrowserHTTPMCPRejectsUnknownExpiredAndCrossOriginSessions(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	payload := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	for _, session := range []string{"", "invalid", strings.Repeat("a", 64)} {
		response := browserMCPRequest(t, browser, session, payload)
		if response.Code != http.StatusNotFound {
			t.Fatalf("unknown MCP session succeeded: %q %d", session, response.Code)
		}
	}
	session := initializeBrowserMCP(t, browser)
	browser.cuaMu.Lock()
	browser.mcpSessions[session].expiresAt = time.Now().Add(-time.Second)
	browser.cuaMu.Unlock()
	if response := browserMCPRequest(t, browser, session, payload); response.Code != http.StatusNotFound {
		t.Fatalf("expired MCP session succeeded: %d", response.Code)
	}
	request := httptest.NewRequest(http.MethodPost, "http://preview/mcp", strings.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	browser.serve(response, request, "/mcp")
	if response.Code != http.StatusForbidden {
		t.Fatalf("browser-origin requests must not reach the server-only MCP endpoint: %d", response.Code)
	}
}

func TestBrowserHTTPMCPTerminationReleasesOnlyItsOwnDriver(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	first, second := initializeBrowserMCP(t, browser), initializeBrowserMCP(t, browser)
	browser.cuaMu.Lock()
	if err := browser.claimDriver(first); err != nil {
		t.Fatal(err)
	}
	browser.cuaMu.Unlock()
	for _, session := range []string{second, first} {
		request := httptest.NewRequest(http.MethodDelete, "http://preview/mcp", nil)
		request.Header.Set("Mcp-Session-Id", session)
		response := httptest.NewRecorder()
		browser.serve(response, request, "/mcp")
		if response.Code != http.StatusOK {
			t.Fatalf("session termination failed: %d", response.Code)
		}
		if session == second && browser.driver.id != first {
			t.Fatal("another session released the active browser driver")
		}
	}
	if browser.driver.id != "" {
		t.Fatal("terminating the controlling session stranded its browser driver")
	}
}

func TestBrowserHTTPMCPBoundsSessionsAndRejectsMalformedRequests(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	session := initializeBrowserMCP(t, browser)
	for _, payload := range []string{
		`[]`, `{}`, `{"jsonrpc":"1.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":{},"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"} {}`,
	} {
		response := browserMCPRequest(t, browser, session, payload)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("malformed MCP request succeeded: %s: %d", payload, response.Code)
		}
	}
	response := browserMCPRequest(t, browser, session, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if response.Code != http.StatusAccepted || response.Body.Len() != 0 {
		t.Fatalf("initialization notification must have no JSON-RPC reply: %d %s", response.Code, response.Body.String())
	}
	for index := 1; index < maxBrowserMCPSessions; index++ {
		initializeBrowserMCP(t, browser)
	}
	response = browserMCPRequest(t, browser, "", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("MCP sessions are unbounded: %d", response.Code)
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("capacity failure is not a JSON response: %v", err)
	}
}
