package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestAPIRoutesRequireBootstrapToken(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)

	unauthorized := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/files", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}
	if got := unauthorized.Header().Get(nanoagentAuthFailureHeader); got != nanoagentAuthFailureHeaderValue {
		t.Fatalf("unauthorized %s = %q", nanoagentAuthFailureHeader, got)
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, "/v1/files", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer test-bootstrap-token")
	authorized := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK {
		t.Fatalf("authorized status = %d body = %s", authorized.Code, authorized.Body.String())
	}
	if got := authorized.Header().Get(nanoagentAuthFailureHeader); got != "" {
		t.Fatalf("authorized response leaked %s = %q", nanoagentAuthFailureHeader, got)
	}
}

func TestFileSearchStopsWhenRequestIsCanceled(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/v1/files/search?query=missing", nil).WithContext(ctx)
	response := httptest.NewRecorder()

	server.handleSearchFiles(response, request)
	if response.Body.Len() != 0 {
		t.Fatalf("canceled search response = %q, want no completed traversal response", response.Body.String())
	}
}

func TestFileSearchSkipsHiddenRuntimeCachesAndPreservesVisibleDirectories(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	for _, path := range []string{
		".cache/needle-cache.txt",
		".cargo/needle-cargo.txt",
		"go/needle-go.txt",
		"src/go/needle-nested-go.txt",
		"src/needle-project.txt",
	} {
		absolute := filepath.Join(server.workspace.root, path)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
			t.Fatalf("create fixture directory: %v", err)
		}
		if err := os.WriteFile(absolute, []byte(path), 0o640); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}

	response := performAuthorizedRequest(
		server.authenticatedRoutes(),
		http.MethodGet,
		"/v1/files/search?query=needle&path=%2F",
		nil,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("search status = %d body = %s", response.Code, response.Body.String())
	}
	var result searchFilesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode search response: %v", err)
	}
	if len(result.Entries) != 3 || result.Entries[0].Path != "/go/needle-go.txt" || result.Entries[1].Path != "/src/go/needle-nested-go.txt" || result.Entries[2].Path != "/src/needle-project.txt" {
		t.Fatalf("search entries = %#v", result.Entries)
	}
	if result.Truncated {
		t.Fatal("search unexpectedly reported truncated results")
	}
}

func TestFileSearchStopsAtTraversalBudgetAndReportsTruncation(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	for _, path := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		if err := os.WriteFile(filepath.Join(server.workspace.root, path), []byte(path), 0o640); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}

	result, err := server.searchFiles(context.Background(), server.workspace.realRoot, "missing", 100, 3)
	if err != nil {
		t.Fatalf("search files: %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("search entries = %#v, want none", result.Entries)
	}
	if !result.Truncated {
		t.Fatal("search did not report traversal-budget truncation")
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

func TestFileAPIAtomicWriteDoesNotExposeTemporaryRenameEvents(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	id, events, err := server.fileWatcher.subscribe(0, "/", server.workspace.realRoot)
	if err != nil {
		t.Fatalf("subscribe workspace: %v", err)
	}
	defer server.fileWatcher.unsubscribe(id)
	body, err := json.Marshal(writeFileRequest{
		Path:    "/document.txt",
		Content: base64.StdEncoding.EncodeToString([]byte("saved")),
	})
	if err != nil {
		t.Fatalf("marshal write request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPut, "/v1/files/content", body)
	if response.Code != http.StatusOK {
		t.Fatalf("write status = %d body = %s", response.Code, response.Body.String())
	}
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	quiet := time.NewTimer(time.Hour)
	if !quiet.Stop() {
		<-quiet.C
	}
	defer quiet.Stop()
	sawTarget := false
	for {
		select {
		case event := <-events:
			if event.Kind == "reset" || strings.Contains(event.Path, "/.nanoagent-write-") {
				t.Fatalf("atomic write leaked temporary filesystem event: %#v", event)
			}
			if event.Path == "/document.txt" {
				sawTarget = true
				quiet.Reset(250 * time.Millisecond)
			}
		case <-quiet.C:
			if sawTarget {
				return
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for the written target event")
		}
	}
}

func TestFileAPIAcceptsTheAdvertisedFourMiBPayload(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	body, err := json.Marshal(writeFileRequest{
		Path:    "/large.bin",
		Content: base64.StdEncoding.EncodeToString(make([]byte, maxFileBytes)),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if len(body) > maxJSONBodyBytes {
		t.Fatalf("encoded request = %d bytes, limit = %d", len(body), maxJSONBodyBytes)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPut, "/v1/files/content", body)
	if response.Code != http.StatusOK {
		t.Fatalf("write status = %d body = %s", response.Code, response.Body.String())
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

func TestFileAPIMoveReportsTheLogicalSymlinkEntryPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional privileges on Windows")
	}
	t.Parallel()
	server := testAPIServer(t)
	if err := os.WriteFile(filepath.Join(server.workspace.root, "target.txt"), []byte("target"), 0o640); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink("target.txt", filepath.Join(server.workspace.root, "link.txt")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	id, events, err := server.fileWatcher.subscribe(0, "/link.txt", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer server.fileWatcher.unsubscribe(id)
	body, err := json.Marshal(moveFileRequest{SourcePath: "/link.txt", DestinationPath: "/moved-link.txt"})
	if err != nil {
		t.Fatalf("marshal move request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPost, "/v1/files/move", body)
	if response.Code != http.StatusOK {
		t.Fatalf("move status = %d body = %s", response.Code, response.Body.String())
	}
	if event := <-events; event.Kind != "renamed" || event.PreviousPath != "/link.txt" || event.Path != "/moved-link.txt" {
		t.Fatalf("symlink move event = %#v, want logical entry paths", event)
	}
	info, err := os.Lstat(filepath.Join(server.workspace.root, "moved-link.txt"))
	if err != nil {
		t.Fatalf("lstat moved symlink: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("moved entry mode = %v, want symlink", info.Mode())
	}
}

func TestFileAPIMoveCorrelatesRawEventsThroughSymlinkedParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional privileges on Windows")
	}
	t.Parallel()
	server := testAPIServer(t)
	actual := filepath.Join(server.workspace.realRoot, "actual")
	if err := os.Mkdir(actual, 0o750); err != nil {
		t.Fatalf("create actual directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(actual, "source.txt"), []byte("source"), 0o640); err != nil {
		t.Fatalf("write source: %v", err)
	}
	if err := os.Symlink("actual", filepath.Join(server.workspace.realRoot, "alias")); err != nil {
		t.Fatalf("create parent symlink: %v", err)
	}
	id, events, err := server.fileWatcher.subscribe(0, "/", actual)
	if err != nil {
		t.Fatalf("subscribe canonical parent: %v", err)
	}
	defer server.fileWatcher.unsubscribe(id)
	body, err := json.Marshal(moveFileRequest{
		SourcePath:      "/alias/source.txt",
		DestinationPath: "/alias/moved.txt",
	})
	if err != nil {
		t.Fatalf("marshal move request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPost, "/v1/files/move", body)
	if response.Code != http.StatusOK {
		t.Fatalf("move status = %d body = %s", response.Code, response.Body.String())
	}
	paired := false
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case event := <-events:
			if event.Kind != "renamed" || event.PreviousPath != "/alias/source.txt" || event.Path != "/alias/moved.txt" {
				t.Fatalf("symlink-parent move event = %#v, want one logical paired rename", event)
			}
			if paired {
				t.Fatalf("symlink-parent move emitted duplicate paired event: %#v", event)
			}
			paired = true
		case <-deadline.C:
			if !paired {
				t.Fatal("timed out waiting for symlink-parent paired rename")
			}
			return
		}
	}
}

func TestFileAPIMoveCorrelatesLeafSymlinkThroughSymlinkedParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional privileges on Windows")
	}
	t.Parallel()
	server := testAPIServer(t)
	actual := filepath.Join(server.workspace.realRoot, "actual")
	if err := os.Mkdir(actual, 0o750); err != nil {
		t.Fatalf("create actual directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(actual, "target.txt"), []byte("target"), 0o640); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink("target.txt", filepath.Join(actual, "link.txt")); err != nil {
		t.Fatalf("create leaf symlink: %v", err)
	}
	if err := os.Symlink("actual", filepath.Join(server.workspace.realRoot, "alias")); err != nil {
		t.Fatalf("create parent symlink: %v", err)
	}
	id, events, err := server.fileWatcher.subscribe(0, "/", actual)
	if err != nil {
		t.Fatalf("subscribe canonical parent: %v", err)
	}
	defer server.fileWatcher.unsubscribe(id)
	body, err := json.Marshal(moveFileRequest{
		SourcePath:      "/alias/link.txt",
		DestinationPath: "/alias/moved-link.txt",
	})
	if err != nil {
		t.Fatalf("marshal move request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPost, "/v1/files/move", body)
	if response.Code != http.StatusOK {
		t.Fatalf("move status = %d body = %s", response.Code, response.Body.String())
	}
	paired := false
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case event := <-events:
			if event.Kind != "renamed" || event.PreviousPath != "/alias/link.txt" || event.Path != "/alias/moved-link.txt" {
				t.Fatalf("combined-symlink move event = %#v, want one logical paired rename", event)
			}
			if paired {
				t.Fatalf("combined-symlink move emitted duplicate paired event: %#v", event)
			}
			paired = true
		case <-deadline.C:
			if !paired {
				t.Fatal("timed out waiting for combined-symlink paired rename")
			}
			info, err := os.Lstat(filepath.Join(actual, "moved-link.txt"))
			if err != nil {
				t.Fatalf("lstat moved symlink: %v", err)
			}
			if info.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("moved entry mode = %v, want symlink", info.Mode())
			}
			return
		}
	}
}

func TestFileAPIMoveDoesNotDependOnSpareWatcherCapacity(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	source := filepath.Join(server.workspace.root, "source.txt")
	if err := os.WriteFile(source, []byte("move me"), 0o640); err != nil {
		t.Fatalf("write source: %v", err)
	}
	server.fileWatcher.mu.Lock()
	for index := range fileWatchDirectoryLimit {
		server.fileWatcher.watched[fmt.Sprintf("/already-watched/%03d", index)] = 1
	}
	server.fileWatcher.mu.Unlock()
	body, err := json.Marshal(moveFileRequest{SourcePath: "/source.txt", DestinationPath: "/destination/moved.txt"})
	if err != nil {
		t.Fatalf("marshal move request: %v", err)
	}

	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPost, "/v1/files/move", body)
	if response.Code != http.StatusOK {
		t.Fatalf("move at watcher limit status = %d body = %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(server.workspace.root, "destination", "moved.txt"))
	if err != nil {
		t.Fatalf("read destination: %v", err)
	}
	if string(content) != "move me" {
		t.Fatalf("destination content = %q", content)
	}
	if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source still exists after move: %v", err)
	}
}

func TestFileAPIAllowsImmediateFollowUpMovesWhileEchoFenceIsPending(t *testing.T) {
	for _, test := range []struct {
		name        string
		prepare     func(*testing.T, *apiServer)
		source      string
		destination string
	}{
		{
			name:        "previous destination becomes source",
			source:      "/b.txt",
			destination: "/c.txt",
		},
		{
			name: "previous source becomes destination",
			prepare: func(t *testing.T, server *apiServer) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(server.workspace.root, "c.txt"), []byte("replacement"), 0o640); err != nil {
					t.Fatalf("write replacement source: %v", err)
				}
			},
			source:      "/c.txt",
			destination: "/a.txt",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := testAPIServer(t)
			_ = server.fileWatcher.close()
			server.fileWatcher = &fileWatcher{
				workspace:        server.workspace,
				subscriptions:    make(map[uint64]fileSubscription),
				watched:          make(map[string]uint32),
				renameFence:      time.Second,
				expectedRenames:  make(map[string]expectedFileRename),
				completedRenames: make(map[uint64]completedFileRename),
			}
			if err := os.WriteFile(filepath.Join(server.workspace.root, "a.txt"), []byte("original"), 0o640); err != nil {
				t.Fatalf("write initial source: %v", err)
			}
			move := func(source string, destination string) *httptest.ResponseRecorder {
				t.Helper()
				body, err := json.Marshal(moveFileRequest{SourcePath: source, DestinationPath: destination})
				if err != nil {
					t.Fatalf("marshal move request: %v", err)
				}
				return performAuthorizedRequest(server.authenticatedRoutes(), http.MethodPost, "/v1/files/move", body)
			}

			if response := move("/a.txt", "/b.txt"); response.Code != http.StatusOK {
				t.Fatalf("initial move status = %d body = %s", response.Code, response.Body.String())
			}
			if test.prepare != nil {
				test.prepare(t, server)
			}
			if response := move(test.source, test.destination); response.Code != http.StatusOK {
				t.Fatalf("follow-up move status = %d body = %s", response.Code, response.Body.String())
			}
			content, err := os.ReadFile(filepath.Join(server.workspace.root, strings.TrimPrefix(test.destination, "/")))
			if err != nil {
				t.Fatalf("read follow-up destination: %v", err)
			}
			want := "original"
			if test.source == "/c.txt" {
				want = "replacement"
			}
			if string(content) != want {
				t.Fatalf("follow-up destination content = %q, want %q", content, want)
			}
		})
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

func TestBeginShutdownCancelsActivePreviewRequests(t *testing.T) {
	server := testAPIServer(t)
	started := make(chan struct{})
	canceled := make(chan struct{})
	server.previewTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		close(canceled)
		return nil, request.Context().Err()
	})

	request := httptest.NewRequest(http.MethodGet, "/v1/preview/43210/events", nil)
	request.Header.Set("Authorization", "Bearer test-bootstrap-token")
	response := httptest.NewRecorder()
	handled := make(chan struct{})
	go func() {
		server.authenticatedRoutes().ServeHTTP(response, request)
		close(handled)
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("preview request did not reach the upstream transport")
	}
	server.beginShutdown()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("preview request context remained active during shutdown")
	}
	select {
	case <-handled:
	case <-time.After(time.Second):
		t.Fatal("preview handler remained blocked during shutdown")
	}
	if response.Code != http.StatusBadGateway {
		t.Fatalf("canceled preview status = %d body = %s", response.Code, response.Body.String())
	}

	rejected := performAuthorizedRequest(
		server.authenticatedRoutes(),
		http.MethodGet,
		"/v1/preview/43210/events",
		nil,
	)
	if rejected.Code != http.StatusServiceUnavailable {
		t.Fatalf("post-shutdown preview status = %d body = %s", rejected.Code, rejected.Body.String())
	}
}

func TestPreviewApplicationCannotSpoofNanoagentAuthenticationFailure(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	server.previewTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Header: http.Header{
				nanoagentAuthFailureHeader: []string{nanoagentAuthFailureHeaderValue},
			},
			Body: io.NopCloser(strings.NewReader("application login required")),
		}, nil
	})

	response := performAuthorizedRequest(
		server.authenticatedRoutes(),
		http.MethodGet,
		"/v1/preview/43210/private",
		nil,
	)
	if response.Code != http.StatusUnauthorized || response.Body.String() != "application login required" {
		t.Fatalf("preview response = status %d body %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get(nanoagentAuthFailureHeader); got != "" {
		t.Fatalf("preview response leaked reserved %s = %q", nanoagentAuthFailureHeader, got)
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

func TestPreviewProxiesWebSocketUpgradesToGuestLoopback(t *testing.T) {
	t.Parallel()
	var upstreamOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" {
			t.Error("preview WebSocket leaked Nanoagent authorization to the guest application")
		}
		if request.Header.Get("Origin") != upstreamOrigin {
			t.Errorf("preview WebSocket origin = %q, want %q", request.Header.Get("Origin"), upstreamOrigin)
		}
		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"vite-hmr"}})
		if err != nil {
			t.Errorf("accept guest WebSocket: %v", err)
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "test complete")
		ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
		defer cancel()
		messageType, payload, err := connection.Read(ctx)
		if err != nil {
			t.Errorf("read guest WebSocket: %v", err)
			return
		}
		if err := connection.Write(ctx, messageType, append([]byte("guest:"), payload...)); err != nil {
			t.Errorf("write guest WebSocket: %v", err)
		}
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse guest WebSocket URL: %v", err)
	}
	upstreamOrigin = upstreamURL.Scheme + "://" + upstreamURL.Host

	server := testAPIServer(t)
	nanoagent := httptest.NewServer(server.authenticatedRoutes())
	t.Cleanup(nanoagent.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(
		ctx,
		"ws"+strings.TrimPrefix(nanoagent.URL, "http")+"/v1/preview/"+upstreamURL.Port()+"/hmr",
		&websocket.DialOptions{
			HTTPHeader: http.Header{
				"Authorization": []string{"Bearer test-bootstrap-token"},
				"Origin":        []string{"https://tengri-session.proompteng.ai"},
			},
			Subprotocols: []string{"vite-hmr"},
		},
	)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("dial preview WebSocket: %v (status %d)", err, status)
	}
	defer connection.Close(websocket.StatusNormalClosure, "test complete")
	if connection.Subprotocol() != "vite-hmr" {
		t.Fatalf("preview WebSocket subprotocol = %q", connection.Subprotocol())
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("write preview WebSocket: %v", err)
	}
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read preview WebSocket: %v", err)
	}
	if messageType != websocket.MessageText || string(payload) != "guest:ping" {
		t.Fatalf("preview WebSocket response = type %d payload %q", messageType, payload)
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
