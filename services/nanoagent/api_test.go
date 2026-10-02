package main

import (
	"bytes"
	"context"
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
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestCodexCallMapsOnlyMatchingMissingRolloutToNotFound(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		params     json.RawMessage
		err        json.RawMessage
		wantStatus codes.Code
		wantError  string
	}{
		{
			name:       "matching missing rollout",
			method:     "thread/resume",
			params:     json.RawMessage(`{"threadId":"thread-1","cwd":"/workspace","runtimeWorkspaceRoots":["/workspace"],"approvalPolicy":"on-request","sandbox":"danger-full-access"}`),
			err:        json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-1"}`),
			wantStatus: codes.NotFound,
			wantError:  codexConversationNotFoundMessage,
		},
		{
			name:       "different thread ID",
			method:     "thread/resume",
			params:     json.RawMessage(`{"threadId":"thread-1"}`),
			err:        json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-2"}`),
			wantStatus: codes.Unavailable,
			wantError:  `Codex app-server request failed: {"code":-32600,"message":"no rollout found for thread id thread-2"}`,
		},
		{
			name:       "non-resume method",
			method:     "thread/start",
			params:     json.RawMessage(`{"threadId":"thread-1"}`),
			err:        json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-1"}`),
			wantStatus: codes.Unavailable,
			wantError:  `Codex app-server request failed: {"code":-32600,"message":"no rollout found for thread id thread-1"}`,
		},
		{
			name:       "other RPC error",
			method:     "thread/resume",
			params:     json.RawMessage(`{"threadId":"thread-1"}`),
			err:        json.RawMessage(`{"code":-32602,"message":"invalid params"}`),
			wantStatus: codes.Unavailable,
			wantError:  `Codex app-server request failed: {"code":-32602,"message":"invalid params"}`,
		},
		{
			name:       "invalid thread ID type",
			method:     "thread/resume",
			params:     json.RawMessage(`{"threadId":123}`),
			err:        json.RawMessage(`{"code":-32600,"message":"no rollout found for thread id thread-1"}`),
			wantStatus: codes.Unavailable,
			wantError:  `Codex app-server request failed: {"code":-32600,"message":"no rollout found for thread id thread-1"}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := testAPIServer(t)
			supervisor, wire := readyCodexSupervisor(t)
			server.codex = supervisor
			responseCh := make(chan error, 1)
			go func() {
				_, err := (&guestRPCServer{api: server}).CodexCall(context.Background(), &pb.CodexRequest{Method: test.method, ParamsJson: test.params})
				responseCh <- err
			}()

			request := readCodexWireRequest(t, wire)
			respondToCodexWireRequest(t, supervisor, request, test.err)

			var callErr error
			select {
			case callErr = <-responseCh:
			case <-time.After(time.Second):
				t.Fatal("Codex call did not return")
			}
			if status.Code(callErr) != test.wantStatus || status.Convert(callErr).Message() != test.wantError {
				t.Fatalf("Codex call = %v, want code %v message %q", callErr, test.wantStatus, test.wantError)
			}

		})
	}
}

func TestCodexCallPreservesCancellation(t *testing.T) {
	server := testAPIServer(t)
	supervisor, _ := readyCodexSupervisor(t)
	server.codex = supervisor
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (&guestRPCServer{api: server}).CodexCall(ctx, &pb.CodexRequest{Method: "thread/resume", ParamsJson: []byte(`{"threadId":"thread-1"}`)})
	if status.Code(err) != codes.Canceled {
		t.Fatalf("canceled Codex call = %v", err)
	}
}

func TestFileSearchStopsWhenRequestIsCanceled(t *testing.T) {
	server := testAPIServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (&guestRPCServer{api: server}).SearchFiles(ctx, &pb.FileSearch{Query: "missing", Path: "/", Limit: 100})
	if status.Code(err) != codes.Canceled {
		t.Fatalf("canceled search = %v", err)
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

	response := fileResult(server.searchFiles(context.Background(), server.workspace.realRoot, "needle", 100, maxSearchVisitedEntries))
	if response.Code != codes.OK {
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

	writeBody := fileWriteInput{
		Path:             "/src/main.rs",
		Content:          []byte("fn main() {}\n"),
		ExpectedRevision: missingFileRevision,
	}
	writeResponse := fileResult(server.writeFile(writeBody))
	if writeResponse.Code != codes.OK {
		t.Fatalf("write status = %d body = %s", writeResponse.Code, writeResponse.Body.String())
	}
	var written writeFileResponse
	if err := json.Unmarshal(writeResponse.Body.Bytes(), &written); err != nil {
		t.Fatalf("decode write response: %v", err)
	}
	wantRevision := revisionForContent([]byte("fn main() {}\n"))
	if written.Path != "/src/main.rs" || written.Size != int64(len("fn main() {}\n")) || written.Revision != wantRevision {
		t.Fatalf("write response = %#v, want path/size/revision for saved content", written)
	}

	readResponse := fileReadResult(server.readFileSnapshot("/src/main.rs"))
	if readResponse.Code != codes.OK || readResponse.Body.String() != "fn main() {}\n" {
		t.Fatalf("read response = status %d body %q", readResponse.Code, readResponse.Body.String())
	}
	if got := readResponse.Revision; got != wantRevision {
		t.Fatalf("read ETag = %q, want strong content ETag", got)
	}

	listResponse := fileResult(server.listFiles("/src"))
	if listResponse.Code != codes.OK {
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

func TestFileReadSnapshotRemainsConsistentDuringMutation(t *testing.T) {
	server := testAPIServer(t)
	if err := os.WriteFile(filepath.Join(server.workspace.root, "read.txt"), []byte("read snapshot"), 0o640); err != nil {
		t.Fatal(err)
	}
	snapshot, err := server.readFileSnapshot("/read.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !server.fileMutationMu.TryLock() {
		t.Fatal("read snapshot retained the mutation lock")
	}
	server.fileMutationMu.Unlock()
	if _, err := server.writeFile(fileWriteInput{Path: "/read.txt", Content: []byte("replacement"), ExpectedRevision: snapshot.revision}); err != nil {
		t.Fatal(err)
	}
	if string(snapshot.content) != "read snapshot" || snapshot.revision != revisionForContent(snapshot.content) {
		t.Fatal("mutation changed the captured read snapshot")
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
	body := fileWriteInput{
		Path:             "/document.txt",
		Content:          []byte("saved"),
		ExpectedRevision: missingFileRevision,
	}

	response := fileResult(server.writeFile(body))
	if response.Code != codes.OK {
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
	body := fileWriteInput{
		Path:             "/large.bin",
		Content:          make([]byte, maxFileBytes),
		ExpectedRevision: missingFileRevision,
	}

	response := fileResult(server.writeFile(body))
	if response.Code != codes.OK {
		t.Fatalf("write status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestFileAPIRequiresValidExpectedRevision(t *testing.T) {
	for _, revision := range []string{"", "abc123", strings.Repeat("A", fileRevisionLength), strings.Repeat("g", fileRevisionLength), `"` + strings.Repeat("a", fileRevisionLength) + `"`, "MISSING"} {
		t.Run(revision, func(t *testing.T) {
			server := testAPIServer(t)
			_, err := (&guestRPCServer{api: server}).WriteFile(context.Background(), &pb.FileWrite{Path: "/invalid-revision.txt", ExpectedRevision: revision})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("invalid revision = %v", err)
			}
			if _, err := os.Stat(filepath.Join(server.workspace.root, "invalid-revision.txt")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid revision created file: %v", err)
			}
		})
	}
}

func TestFileAPIRejectsStaleAndCreateOnlyRevisions(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	target := filepath.Join(server.workspace.root, "document.txt")
	if err := os.WriteFile(target, []byte("before"), 0o640); err != nil {
		t.Fatalf("write initial document: %v", err)
	}
	if err := os.WriteFile(target, []byte("current"), 0o640); err != nil {
		t.Fatalf("change document outside API: %v", err)
	}

	write := func(expectedRevision string, content string) *fileOperationResult {
		t.Helper()
		body := fileWriteInput{
			Path:             "/document.txt",
			Content:          []byte(content),
			ExpectedRevision: expectedRevision,
		}
		return fileResult(server.writeFile(body))
	}

	response := write(revisionForContent([]byte("before")), "replacement")
	if response.Code != codes.Aborted {
		t.Fatalf("stale write status = %d body = %s", response.Code, response.Body.String())
	}
	var conflict revisionConflictResponse
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode stale revision response: %v", err)
	}
	wantCurrent := revisionForContent([]byte("current"))
	if conflict.CurrentRevision != wantCurrent || conflict.Error == "" {
		t.Fatalf("stale revision response = %#v, want current revision %q", conflict, wantCurrent)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "current" {
		t.Fatalf("stale write changed document: content=%q err=%v", content, err)
	}

	response = write(missingFileRevision, "create-only")
	if response.Code != codes.Aborted {
		t.Fatalf("create-only existing write status = %d body = %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode create-only conflict: %v", err)
	}
	if conflict.CurrentRevision != wantCurrent {
		t.Fatalf("create-only current revision = %q, want %q", conflict.CurrentRevision, wantCurrent)
	}

	missingTarget := filepath.Join(server.workspace.root, "new-document.txt")
	body := fileWriteInput{
		Path:             "/new-document.txt",
		Content:          []byte("create"),
		ExpectedRevision: wantCurrent,
	}
	response = fileResult(server.writeFile(body))
	if response.Code != codes.Aborted {
		t.Fatalf("missing-target stale write status = %d body = %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode missing-target conflict: %v", err)
	}
	if conflict.CurrentRevision != missingFileRevision {
		t.Fatalf("missing-target current revision = %q, want %q", conflict.CurrentRevision, missingFileRevision)
	}
	if _, err := os.Stat(missingTarget); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale missing-target write created a file: %v", err)
	}
}

func TestFileAPIConcurrentWritersUseOneMatchingRevision(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	target := filepath.Join(server.workspace.root, "concurrent.txt")
	if err := os.WriteFile(target, []byte("base"), 0o640); err != nil {
		t.Fatalf("write initial file: %v", err)
	}
	wantInitial := revisionForContent([]byte("base"))
	type result struct {
		content  string
		response *fileOperationResult
		revision string
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, content := range []string{"first writer", "second writer"} {
		content := content
		go func() {
			body := fileWriteInput{
				Path:             "/concurrent.txt",
				Content:          []byte(content),
				ExpectedRevision: wantInitial,
			}
			<-start
			results <- result{content: content, response: fileResult(server.writeFile(body))}
		}()
	}
	close(start)
	var winner result
	var loser result
	for range 2 {
		current := <-results
		if current.response == nil {
			t.Fatalf("concurrent writer %q failed before request: %s", current.content, current.revision)
		}
		switch current.response.Code {
		case codes.OK:
			if winner.response != nil {
				t.Fatalf("both concurrent writes succeeded: %#v and %#v", winner.response, current.response)
			}
			winner = current
		case codes.Aborted:
			if loser.response != nil {
				t.Fatalf("both concurrent writes conflicted: %#v and %#v", loser.response, current.response)
			}
			loser = current
		default:
			t.Fatalf("concurrent writer %q status = %d body = %s", current.content, current.response.Code, current.response.Body.String())
		}
	}
	if winner.response == nil || loser.response == nil {
		t.Fatalf("concurrent results winner=%#v loser=%#v", winner, loser)
	}
	var stale revisionConflictResponse
	if err := json.Unmarshal(loser.response.Body.Bytes(), &stale); err != nil {
		t.Fatalf("decode concurrent stale response: %v", err)
	}
	wantWinner := revisionForContent([]byte(winner.content))
	if stale.CurrentRevision != wantWinner {
		t.Fatalf("concurrent stale revision = %q, want winner %q", stale.CurrentRevision, wantWinner)
	}
	var acknowledged writeFileResponse
	if err := json.Unmarshal(winner.response.Body.Bytes(), &acknowledged); err != nil {
		t.Fatalf("decode concurrent winner response: %v", err)
	}
	if acknowledged.Revision != wantWinner {
		t.Fatalf("concurrent winner revision = %q, want %q", acknowledged.Revision, wantWinner)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read concurrent result: %v", err)
	}
	if string(content) != winner.content {
		t.Fatalf("concurrent final content = %q, want winner %q", content, winner.content)
	}
}

func TestSyncWorkspaceDirectoriesPropagatesParentSyncFailure(t *testing.T) {
	server := testAPIServer(t)
	sentinel := errors.New("injected parent sync failure")
	var synced []string
	err := syncWorkspaceDirectoriesWith(server.workspace, func(_ workspace, relative string) error {
		synced = append(synced, relative)
		return sentinel
	}, "nested/created")
	if !errors.Is(err, sentinel) {
		t.Fatalf("sync directories error = %v, want injected error", err)
	}
	if len(synced) != 1 || synced[0] != "nested/created" {
		t.Fatalf("sync directories attempted %v, want stop at first failed directory", synced)
	}
}

func TestFileAPIMutationAcknowledgementFailureDoesNotHideVisibleState(t *testing.T) {
	tests := []struct {
		name string
		run  func(*testing.T, *apiServer)
	}{
		{
			name: "write",
			run: func(t *testing.T, server *apiServer) {
				t.Helper()
				body := fileWriteInput{
					Path:             "/written.txt",
					Content:          []byte("visible"),
					ExpectedRevision: missingFileRevision,
				}
				response := fileResult(server.writeFile(body))
				if response.Code == codes.OK {
					t.Fatalf("write acknowledgement status = %d body = %s", response.Code, response.Body.String())
				}
				content, err := os.ReadFile(filepath.Join(server.workspace.root, "written.txt"))
				if err != nil || string(content) != "visible" {
					t.Fatalf("write state = %q err=%v, want visible content after failed acknowledgement", content, err)
				}
			},
		},
		{
			name: "mkdir",
			run: func(t *testing.T, server *apiServer) {
				t.Helper()
				body := pathRequest{Path: "/created/nested"}
				response := fileResult(server.createDirectory(body))
				if response.Code == codes.OK {
					t.Fatalf("mkdir acknowledgement status = %d body = %s", response.Code, response.Body.String())
				}
				info, err := os.Stat(filepath.Join(server.workspace.root, "created", "nested"))
				if err != nil || !info.IsDir() {
					t.Fatalf("mkdir state = %#v err=%v, want visible directory after failed acknowledgement", info, err)
				}
			},
		},
		{
			name: "move",
			run: func(t *testing.T, server *apiServer) {
				t.Helper()
				source := filepath.Join(server.workspace.root, "source.txt")
				if err := os.WriteFile(source, []byte("moved"), 0o640); err != nil {
					t.Fatalf("write move source: %v", err)
				}
				body := moveFileRequest{SourcePath: "/source.txt", DestinationPath: "/moved.txt"}
				response := fileResult(server.moveFile(body))
				if response.Code == codes.OK {
					t.Fatalf("move acknowledgement status = %d body = %s", response.Code, response.Body.String())
				}
				content, err := os.ReadFile(filepath.Join(server.workspace.root, "moved.txt"))
				if err != nil || string(content) != "moved" {
					t.Fatalf("move destination state = %q err=%v, want visible destination after failed acknowledgement", content, err)
				}
				if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("move source state err=%v, want source removed", err)
				}
			},
		},
		{
			name: "delete",
			run: func(t *testing.T, server *apiServer) {
				t.Helper()
				target := filepath.Join(server.workspace.root, "deleted.txt")
				if err := os.WriteFile(target, []byte("gone"), 0o640); err != nil {
					t.Fatalf("write delete target: %v", err)
				}
				body := deleteFileRequest{Path: "/deleted.txt", Recursive: false}
				response := fileResult(server.deleteFile(body))
				if response.Code == codes.OK {
					t.Fatalf("delete acknowledgement status = %d body = %s", response.Code, response.Body.String())
				}
				if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("delete target state err=%v, want target removed", err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := testAPIServer(t)
			server.syncDirectories = func(_ workspace, _ ...string) error {
				return errors.New("injected parent sync failure")
			}
			test.run(t, server)
		})
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
	body := fileWriteInput{
		Path:             "/script.sh",
		Content:          []byte("#!/bin/sh\nexit 0\n"),
		ExpectedRevision: revisionForContent([]byte("#!/bin/sh\nexit 1\n")),
	}

	response := fileResult(server.writeFile(body))
	if response.Code != codes.OK {
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

	response := fileReadResult(server.readFileSnapshot("/escape/secret"))
	if response.Code != codes.PermissionDenied {
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

	readResponse := fileReadResult(server.readFileSnapshot("/visible/auth.json"))
	if readResponse.Code != codes.NotFound {
		t.Fatalf("internal symlink read status = %d body = %s", readResponse.Code, readResponse.Body.String())
	}

	writeBody := fileWriteInput{
		Path:             "/visible/injected.json",
		Content:          []byte("blocked"),
		ExpectedRevision: missingFileRevision,
	}
	writeResponse := fileResult(server.writeFile(writeBody))
	if writeResponse.Code != codes.NotFound {
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
	body := moveFileRequest{SourcePath: "/link.txt", DestinationPath: "/moved-link.txt"}

	response := fileResult(server.moveFile(body))
	if response.Code != codes.OK {
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
	body := moveFileRequest{
		SourcePath:      "/alias/source.txt",
		DestinationPath: "/alias/moved.txt",
	}

	response := fileResult(server.moveFile(body))
	if response.Code != codes.OK {
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

func TestWatchFilesRoutesPairedRenameThroughSymlinkedParent(t *testing.T) {
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

	client, _ := rpcTestClient(t, server)
	ctx, cancel := context.WithCancel(rpcTestContext(t))
	defer cancel()
	stream, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/alias", After: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Header(); err != nil {
		t.Fatal(err)
	}

	body := moveFileRequest{
		SourcePath:      "/alias/source.txt",
		DestinationPath: "/alias/moved.txt",
	}
	moveResponse := fileResult(server.moveFile(body))
	if moveResponse.Code != codes.OK {
		t.Fatalf("move status = %d body = %s", moveResponse.Code, moveResponse.Body.String())
	}

	result := make(chan struct {
		event *pb.FileEvent
		err   error
	}, 1)
	go func() {
		for {
			event, decodeErr := stream.Recv()
			if decodeErr != nil {
				result <- struct {
					event *pb.FileEvent
					err   error
				}{err: decodeErr}
				return
			}
			if event.Kind != "reset" {
				result <- struct {
					event *pb.FileEvent
					err   error
				}{event: event, err: decodeErr}
				return
			}
		}
	}()
	select {
	case decoded := <-result:
		if decoded.err != nil {
			t.Fatalf("decode watch event: %v", decoded.err)
		}
		if decoded.event.Kind != "renamed" ||
			decoded.event.PreviousPath != "/alias/source.txt" ||
			decoded.event.Path != "/alias/moved.txt" {
			t.Fatalf("watch event = %#v, want logical paired rename", decoded.event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for paired rename on the canonical symlink watch")
	}
}

func TestWatchFilesWithoutCursorStartsAfterHistoricalEvents(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	server.fileWatcher.publish(fileEvent{Kind: "changed", Path: "/historical.txt"})

	client, _ := rpcTestClient(t, server)
	ctx, cancel := context.WithCancel(rpcTestContext(t))
	defer cancel()
	stream, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/", After: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Header(); err != nil {
		t.Fatal(err)
	}

	result := make(chan struct {
		events []*pb.FileEvent
		err    error
	}, 1)
	go func() {
		events := make([]*pb.FileEvent, 0, 2)
		for range 2 {
			event, decodeErr := stream.Recv()
			if decodeErr != nil {
				result <- struct {
					events []*pb.FileEvent
					err    error
				}{events: events, err: decodeErr}
				return
			}
			events = append(events, event)
		}
		result <- struct {
			events []*pb.FileEvent
			err    error
		}{events: events}
	}()
	server.fileWatcher.publish(fileEvent{Kind: "changed", Path: "/current.txt"})
	select {
	case decoded := <-result:
		if decoded.err != nil {
			t.Fatalf("decode watch event: %v", decoded.err)
		}
		if len(decoded.events) != 2 {
			t.Fatalf("watch events = %#v, want snapshot and current event", decoded.events)
		}
		if snapshot := decoded.events[0]; snapshot.Sequence != 1 || snapshot.Kind != "reset" || snapshot.Path != "/" {
			t.Fatalf("watch snapshot = %#v, want starting cursor 1", snapshot)
		}
		if current := decoded.events[1]; current.Sequence != 2 || current.Path != "/current.txt" {
			t.Fatalf("current watch event = %#v, want post-subscription event", current)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for snapshot and post-subscription file event")
	}
}

func TestFileWatcherSubscribeCurrentEmitsZeroStartingCursor(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	id, events, err := server.fileWatcher.subscribeCurrent("/", server.workspace.realRoot)
	if err != nil {
		t.Fatalf("subscribe from current sequence: %v", err)
	}
	defer server.fileWatcher.unsubscribe(id)

	select {
	case event := <-events:
		if event.Sequence != 0 || event.Kind != "reset" || event.Path != "/" {
			t.Fatalf("initial watch snapshot = %#v, want zero starting cursor", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for initial watch snapshot")
	}
}

func TestWatchFilesExplicitZeroReplaysHistoricalEvents(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	server.fileWatcher.publish(fileEvent{Kind: "changed", Path: "/historical.txt"})

	client, _ := rpcTestClient(t, server)
	ctx, cancel := context.WithCancel(rpcTestContext(t))
	defer cancel()
	zero := uint64(0)
	stream, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/", After: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Header(); err != nil {
		t.Fatal(err)
	}

	event, err := stream.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if event.Sequence != 1 || event.Kind != "changed" || event.Path != "/historical.txt" {
		t.Fatalf("replay event = %#v, want historical event at sequence 1", event)
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
	body := moveFileRequest{
		SourcePath:      "/alias/link.txt",
		DestinationPath: "/alias/moved-link.txt",
	}

	response := fileResult(server.moveFile(body))
	if response.Code != codes.OK {
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
	body := moveFileRequest{SourcePath: "/source.txt", DestinationPath: "/destination/moved.txt"}

	response := fileResult(server.moveFile(body))
	if response.Code != codes.OK {
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
			move := func(source string, destination string) *fileOperationResult {
				t.Helper()
				body := moveFileRequest{SourcePath: source, DestinationPath: destination}
				return fileResult(server.moveFile(body))
			}

			if response := move("/a.txt", "/b.txt"); response.Code != codes.OK {
				t.Fatalf("initial move status = %d body = %s", response.Code, response.Body.String())
			}
			if test.prepare != nil {
				test.prepare(t, server)
			}
			if response := move(test.source, test.destination); response.Code != codes.OK {
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
		response := fileReadResult(server.readFileSnapshot("/" + name + "/config.json"))
		if response.Code != codes.NotFound {
			t.Fatalf("%s read status = %d body = %s", name, response.Code, response.Body.String())
		}
	}
}

type revisionConflictResponse struct {
	Error           string `json:"error"`
	CurrentRevision string `json:"currentRevision,omitempty"`
}

type fileOperationResult struct {
	Code     codes.Code
	Body     *bytes.Buffer
	Revision string
}

func fileResult[T any](value T, err error) *fileOperationResult {
	result := &fileOperationResult{Code: codes.OK, Body: new(bytes.Buffer)}
	if err != nil {
		failure := workspaceFailure(err)
		result.Code = status.Code(rpcOperationError(err))
		_ = json.NewEncoder(result.Body).Encode(revisionConflictResponse{Error: failure.message, CurrentRevision: failure.currentRevision})
		return result
	}
	_ = json.NewEncoder(result.Body).Encode(value)
	return result
}
func fileReadResult(value fileReadSnapshot, err error) *fileOperationResult {
	if err != nil {
		return fileResult(value, err)
	}
	return &fileOperationResult{Code: codes.OK, Body: bytes.NewBuffer(value.content), Revision: value.revision}
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
	server.previewRoutes().ServeHTTP(response, request)
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
		server.previewRoutes().ServeHTTP(response, request)
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
		server.previewRoutes(),
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
		server.previewRoutes(),
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
		response := performAuthorizedRequest(server.previewRoutes(), http.MethodGet, "/v1/preview/"+port+"/", nil)
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
	nanoagent := httptest.NewServer(server.previewRoutes())
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
