package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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

func TestBootstrapCodexUsesTheSanitizedChildEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell bootstrap helper requires Unix")
	}
	home := t.TempDir()
	helper := filepath.Join(t.TempDir(), "codex-bootstrap-test")
	script := `#!/bin/sh
set -eu
test "$1" = '--install-only'
test -z "${MICROVM_BOOTSTRAP_TOKEN:-}"
test -z "${MICROVM_BOOTSTRAP_TOKEN_FD:-}"
test "$HOME" = '` + home + `'`
	if err := os.WriteFile(helper, []byte(script), 0o700); err != nil {
		t.Fatalf("write bootstrap helper: %v", err)
	}
	t.Setenv(bootstrapTokenEnvironmentKey, "must-not-reach-installer")
	t.Setenv(bootstrapTokenFDEnvironmentKey, "7")
	t.Setenv("HOME", home)

	if err := bootstrapCodex(context.Background(), helper, time.Second); err != nil {
		t.Fatalf("bootstrapCodex() error = %v", err)
	}
}

func TestBootstrapCodexRejectsRelativeCommands(t *testing.T) {
	t.Parallel()
	if err := bootstrapCodex(context.Background(), "bootstrap-codex", time.Second); err == nil {
		t.Fatal("bootstrapCodex() accepted a PATH-resolved command")
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

func TestReadinessWaitsForCodexInitialization(t *testing.T) {
	t.Parallel()
	server := testAPIServer(t)
	server.codex = newCodexSupervisor("/usr/bin/false", t.TempDir())
	reader, writer := io.Pipe()
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	handler := newHandler(server)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("uninitialized readiness status = %d", response.Code)
	}
	for _, path := range []string{"/livez", "/healthz"} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("uninitialized liveness status for %s = %d", path, response.Code)
		}
	}

	server.codex.mu.Lock()
	server.codex.stdin = writer
	close(server.codex.generation.ready)
	server.codex.mu.Unlock()
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("initialized readiness status = %d", response.Code)
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

func TestBootstrapUserHomeMakesTheWorkspaceSymlinkUsableAfterTheHomeMountHidesImageData(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspaceAlias := filepath.Join(t.TempDir(), "workspace")
	if err := os.Symlink(filepath.Join(home, "workspace"), workspaceAlias); err != nil {
		t.Fatalf("create workspace symlink: %v", err)
	}

	if err := bootstrapUserHome(home); err != nil {
		t.Fatalf("bootstrapUserHome() error = %v", err)
	}
	workspace, err := newWorkspace(workspaceAlias)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	t.Cleanup(func() { _ = workspace.close() })
	want, err := filepath.EvalSymlinks(filepath.Join(home, "workspace"))
	if err != nil {
		t.Fatalf("resolve persistent workspace: %v", err)
	}
	if workspace.realRoot != want {
		t.Fatalf("workspace root = %q, want persistent home workspace", workspace.realRoot)
	}
}

func TestBeginShutdownClosesStreamingSubscriptions(t *testing.T) {
	server := testAPIServer(t)
	_, fileEvents, err := server.fileWatcher.subscribe(0, "/", "")
	if err != nil {
		t.Fatalf("subscribe to file events: %v", err)
	}
	server.codex = newCodexSupervisor("/usr/bin/false", server.workspace.realRoot)
	_, codexEvents, err := server.codex.subscribe(0)
	if err != nil {
		t.Fatalf("subscribe to Codex events: %v", err)
	}

	server.beginShutdown()

	if _, open := <-fileEvents; open {
		t.Fatal("file event stream remained open during shutdown")
	}
	if _, open := <-codexEvents; open {
		t.Fatal("Codex event stream remained open during shutdown")
	}
	if _, _, err := server.fileWatcher.subscribe(0, "/", ""); err == nil {
		t.Fatal("file watcher accepted a subscription after shutdown")
	}
	if _, _, err := server.codex.subscribe(0); err == nil {
		t.Fatal("Codex supervisor accepted a subscription after shutdown")
	}
}

func TestNewAPIServerStartsCodexInConfiguredWorkspace(t *testing.T) {
	root := t.TempDir()
	server, err := newAPIServer(apiConfig{
		bootstrapToken: "test-bootstrap-token",
		codexBinary:    "/usr/bin/false",
		startCodex:     true,
		workspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("newAPIServer() error = %v", err)
	}
	t.Cleanup(server.close)

	if server.codex == nil {
		t.Fatal("Codex supervisor was not configured")
	}
	if server.codex.cwd != server.workspace.realRoot {
		t.Fatalf("Codex cwd = %q, want %q", server.codex.cwd, server.workspace.realRoot)
	}
}

func testAPIServer(t *testing.T) *apiServer {
	t.Helper()
	root := t.TempDir()
	server, err := newAPIServer(apiConfig{
		bootstrapToken: "test-bootstrap-token",
		codexBinary:    "/usr/bin/false",
		homeRoot:       root,
		workspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("newAPIServer() error = %v", err)
	}
	t.Cleanup(server.close)
	return server
}
