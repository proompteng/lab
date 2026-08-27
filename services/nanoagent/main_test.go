package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCollectEvidenceDoesNotExposeBootstrapTokenMetadata(t *testing.T) {
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

func TestRuntimeRootsPreserveTheWritableKataCompatibilityMount(t *testing.T) {
	t.Parallel()

	home, workspace := runtimeRoots("", "")
	if home != "/workspace" || workspace != "/workspace" {
		t.Fatalf("runtimeRoots() = (%q, %q), want /workspace for both", home, workspace)
	}

	home, workspace = runtimeRoots(" /home/nanoagent ", " /workspace ")
	if home != "/home/nanoagent" || workspace != "/workspace" {
		t.Fatalf("runtimeRoots(explicit) = (%q, %q)", home, workspace)
	}
}

func TestEvidenceHandler(t *testing.T) {
	t.Parallel()

	want := evidence{MicroVMID: "firecracker-canary", State: "ready"}
	server := testAPIServer(t)
	server.evidence = want
	response := performAuthorizedRequest(server.authenticatedRoutes(), http.MethodGet, "/v1/evidence", nil)

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

func TestEvidenceHandlerRequiresAuthentication(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	response := httptest.NewRecorder()
	server.authenticatedRoutes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/evidence", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestProbeHandlers(t *testing.T) {
	t.Parallel()

	for _, path := range []string{"/livez", "/readyz", "/healthz"} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			response := httptest.NewRecorder()

			newHandler(testAPIServer(t)).ServeHTTP(response, request)

			if response.Code != http.StatusOK || response.Body.String() != "{\"status\":\"ok\"}\n" {
				t.Fatalf("response = status %d body %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestBootstrapUserHomeCreatesPersistentToolDirectories(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	bashrc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(bashrc, []byte("preserve-me\n"), 0o640); err != nil {
		t.Fatalf("write existing bashrc: %v", err)
	}

	if err := bootstrapUserHome(home); err != nil {
		t.Fatalf("bootstrapUserHome() error = %v", err)
	}

	for _, path := range []string{"workspace", ".cache", ".local/bin", ".bun", ".cargo", "go/bin", ".codex"} {
		info, err := os.Stat(filepath.Join(home, path))
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", path)
		}
	}
	codexHome, err := os.Stat(filepath.Join(home, ".codex"))
	if err != nil {
		t.Fatalf("stat Codex home: %v", err)
	}
	if codexHome.Mode().Perm() != 0o700 {
		t.Fatalf("Codex home mode = %o, want 700", codexHome.Mode().Perm())
	}
	content, err := os.ReadFile(bashrc)
	if err != nil {
		t.Fatalf("read existing bashrc: %v", err)
	}
	if string(content) != "preserve-me\n" {
		t.Fatalf("existing bashrc was replaced: %q", content)
	}
}

func TestBeginShutdownClosesStreamingSubscriptions(t *testing.T) {
	server := testAPIServer(t)
	_, fileEvents, err := server.fileWatcher.subscribe(0, "/", "")
	if err != nil {
		t.Fatalf("subscribe to file events: %v", err)
	}

	server.beginShutdown()

	if _, open := <-fileEvents; open {
		t.Fatal("file event stream remained open during shutdown")
	}
	if _, _, err := server.fileWatcher.subscribe(0, "/", ""); err == nil {
		t.Fatal("file watcher accepted a subscription after shutdown")
	}
}

func testAPIServer(t *testing.T) *apiServer {
	t.Helper()
	root := t.TempDir()
	server, err := newAPIServer(apiConfig{
		bootstrapToken: "test-bootstrap-token",
		homeRoot:       root,
		workspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("newAPIServer() error = %v", err)
	}
	t.Cleanup(server.close)
	return server
}
