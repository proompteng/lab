package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAPIRoutesRequireBootstrapToken(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)

	unauthorized := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/files", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, "/v1/files", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer test-bootstrap-token")
	authorized := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK {
		t.Fatalf("authorized status = %d body = %s", authorized.Code, authorized.Body.String())
	}
}

func TestFileAPIWritesReadsAndListsWorkspaceFiles(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	handler := server.authenticatedRoutes()

	writeBody, err := json.Marshal(writeFileRequest{
		Path:    "/src/main.rs",
		Content: base64.StdEncoding.EncodeToString([]byte("fn main() {}\n")),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	writeResponse := performAuthorizedRequest(handler, http.MethodPut, "/v1/files/content", writeBody)
	if writeResponse.Code != http.StatusOK {
		t.Fatalf("write status = %d body = %s", writeResponse.Code, writeResponse.Body.String())
	}

	readResponse := performAuthorizedRequest(handler, http.MethodGet, "/v1/files/content?path=%2Fsrc%2Fmain.rs", nil)
	if readResponse.Code != http.StatusOK || readResponse.Body.String() != "fn main() {}\n" {
		t.Fatalf("read response = status %d body %q", readResponse.Code, readResponse.Body.String())
	}

	listResponse := performAuthorizedRequest(handler, http.MethodGet, "/v1/files?path=%2Fsrc", nil)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", listResponse.Code, listResponse.Body.String())
	}
	var listed fileList
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed.Entries) != 1 || listed.Entries[0].Path != "/src/main.rs" {
		t.Fatalf("listed files = %#v", listed)
	}
}

func TestDirectoryListingIsBounded(t *testing.T) {
	t.Parallel()
	directoryPath := t.TempDir()
	for _, name := range []string{"one", "two", "three"} {
		if err := os.WriteFile(filepath.Join(directoryPath, name), []byte(name), 0o600); err != nil {
			t.Fatalf("write fixture %q: %v", name, err)
		}
	}
	directory, err := os.Open(directoryPath)
	if err != nil {
		t.Fatalf("open fixture directory: %v", err)
	}
	defer directory.Close()

	if _, err := readDirectoryEntries(directory, 2); !errors.Is(err, errTooManyDirectoryEntries) {
		t.Fatalf("readDirectoryEntries() error = %v, want %v", err, errTooManyDirectoryEntries)
	}
}

func TestFileAPIAtomicWritePreservesExecutableMode(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	target := filepath.Join(server.workspace.root, "script.sh")
	if err := os.WriteFile(target, []byte("#!/bin/sh\nexit 1\n"), 0o750); err != nil {
		t.Fatalf("write executable fixture: %v", err)
	}
	body, err := json.Marshal(writeFileRequest{
		Path:    "/script.sh",
		Content: base64.StdEncoding.EncodeToString([]byte("#!/bin/sh\nexit 0\n")),
	})
	if err != nil {
		t.Fatalf("marshal write request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPut, "/v1/files/content", body)
	if response.Code != http.StatusOK {
		t.Fatalf("write status = %d body = %s", response.Code, response.Body.String())
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat rewritten executable: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o750 {
		t.Fatalf("rewritten mode = %#o, want %#o", got, os.FileMode(0o750))
	}
}

func TestFileAPIRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional privileges on Windows")
	}
	t.Parallel()
	server := testAPIServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(server.workspace.root, "escape")); err != nil {
		t.Fatalf("os.Symlink() error = %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodGet, "/v1/files/content?path=%2Fescape%2Fsecret", nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("escape status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestFileAPIRejectsSymlinkIntoInternalMetadata(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional privileges on Windows")
	}
	t.Parallel()
	server := testAPIServer(t)
	internal := filepath.Join(server.workspace.root, ".codex")
	if err := os.MkdirAll(internal, 0o700); err != nil {
		t.Fatalf("create Codex metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(internal, "auth.json"), []byte("private"), 0o600); err != nil {
		t.Fatalf("write Codex metadata: %v", err)
	}
	if err := os.Symlink(internal, filepath.Join(server.workspace.root, "visible")); err != nil {
		t.Fatalf("os.Symlink() error = %v", err)
	}

	readResponse := performAuthorizedRequest(
		server.authenticatedRoutes(),
		http.MethodGet,
		"/v1/files/content?path=%2Fvisible%2Fauth.json",
		nil,
	)
	if readResponse.Code != http.StatusNotFound {
		t.Fatalf("internal symlink read status = %d body = %s", readResponse.Code, readResponse.Body.String())
	}

	writeBody, err := json.Marshal(writeFileRequest{
		Path:    "/visible/injected.json",
		Content: base64.StdEncoding.EncodeToString([]byte("blocked")),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	writeResponse := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPut, "/v1/files/content", writeBody)
	if writeResponse.Code != http.StatusNotFound {
		t.Fatalf("internal symlink write status = %d body = %s", writeResponse.Code, writeResponse.Body.String())
	}
	if _, err := os.Stat(filepath.Join(internal, "injected.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("internal metadata was modified through a symlink: %v", err)
	}
}

func TestFileAPIHidesTengriAndCodexMetadata(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	for _, name := range []string{".codex", ".tengri"} {
		if err := os.MkdirAll(filepath.Join(server.workspace.root, name), 0o700); err != nil {
			t.Fatalf("create metadata directory: %v", err)
		}
		response := performAuthorizedRequest(
			server.authenticatedRoutes(),
			http.MethodGet,
			"/v1/files/content?path=%2F"+name+"%2Fconfig.json",
			nil,
		)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s read status = %d body = %s", name, response.Code, response.Body.String())
		}
	}
}

func TestPreviewOnlyProxiesToGuestLoopback(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	server.previewTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "http://127.0.0.1:43210/hello?mode=full" {
			t.Fatalf("preview target = %q", request.URL.String())
		}
		if request.Header.Get("Authorization") != "" {
			t.Fatal("preview leaked Nanoagent authorization to the guest application")
		}
		if request.Header.Get("Origin") != "http://127.0.0.1:43210" {
			t.Fatalf("preview origin = %q", request.Header.Get("Origin"))
		}
		for _, header := range []string{
			"Connection",
			"Forwarded",
			"Keep-Alive",
			"Proxy-Authorization",
			"Proxy-Connection",
			"X-Forwarded-For",
			"X-Forwarded-Host",
			"X-Forwarded-Proto",
		} {
			if value := request.Header.Get(header); value != "" {
				t.Fatalf("preview forwarded %s = %q", header, value)
			}
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Content-Type": []string{"text/plain"},
				"Server":       []string{"guest-development-server"},
			},
			Body: io.NopCloser(strings.NewReader("guest:" + request.URL.RequestURI())),
		}, nil
	})
	target := "/v1/preview/43210/hello?mode=full"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set("Authorization", "Bearer test-bootstrap-token")
	request.Header.Set("Connection", "keep-alive, X-Internal")
	request.Header.Set("Forwarded", "for=203.0.113.7")
	request.Header.Set("Keep-Alive", "timeout=5")
	request.Header.Set("Origin", "https://tengri-session.proompteng.ai")
	request.Header.Set("Proxy-Authorization", "Basic private")
	request.Header.Set("Proxy-Connection", "keep-alive")
	request.Header.Set("X-Forwarded-For", "203.0.113.7")
	request.Header.Set("X-Forwarded-Host", "private.example")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Internal", "private")
	response := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "guest:/hello?mode=full" {
		t.Fatalf("preview response = status %d body %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Server") != "" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("preview response headers = %#v", response.Header())
	}
}

func TestPreviewRejectsReservedAndPrivilegedPorts(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	for _, port := range []string{"0", "22", "8080", "65536", "not-a-port"} {
		response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodGet, "/v1/preview/"+port+"/", nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("preview port %q status = %d body = %q", port, response.Code, response.Body.String())
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func performAuthorizedRequest(handler http.Handler, method string, target string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-bootstrap-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
