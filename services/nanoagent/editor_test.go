package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestEditorBridgePairsWindowsAndReplaysDirtyState(t *testing.T) {
	bridge := newEditorBridge()
	defer bridge.close()
	browser := httptest.NewServer(http.HandlerFunc(bridge.browser))
	defer browser.Close()
	extension := httptest.NewServer(http.HandlerFunc(bridge.extension))
	defer extension.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dial := func(server *httptest.Server, session string) *websocket.Conn {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/?session="+session, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.CloseNow() })
		return conn
	}
	id := strings.Repeat("a", 24)
	ext := dial(extension, id)
	if err := ext.Write(ctx, websocket.MessageText, []byte(`{"type":"state","dirty":true}`)); err != nil {
		t.Fatal(err)
	}
	client := dial(browser, id)
	_, state, err := client.Read(ctx)
	if err != nil || string(state) != `{"type":"state","dirty":true}` {
		t.Fatalf("dirty state = %s, %v", state, err)
	}
	other := dial(extension, strings.Repeat("b", 24))
	_ = other.Write(ctx, websocket.MessageText, []byte(`{"type":"state","dirty":false}`))
	request := `{"type":"open","id":"1","path":"/hello.ts"}`
	if err := client.Write(ctx, websocket.MessageText, []byte(request)); err != nil {
		t.Fatal(err)
	}
	_, received, err := ext.Read(ctx)
	if err != nil || string(received) != request {
		t.Fatalf("file command = %s, %v", received, err)
	}
	if validatePreviewPort(editorBridgePort) == nil {
		t.Fatal("extension listener is reachable through a preview")
	}
}

func TestEditorIntegrationPreservesUserSettings(t *testing.T) {
	root := t.TempDir()
	if err := installEditorIntegration(root); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(root, "data", "User", "settings.json")
	if err := os.WriteFile(settings, []byte(`{"editor.fontSize":17}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installEditorIntegration(root); err != nil {
		t.Fatal(err)
	}
	value, err := os.ReadFile(settings)
	if err != nil || string(value) != `{"editor.fontSize":17}` {
		t.Fatalf("settings overwritten: %s, %v", value, err)
	}
}

// The browser suite uses the real API, process supervisor, bridge, and upstream
// workbench. Only provisioning and identity are supplied by the local fixture.
func TestEditorBrowserFixture(t *testing.T) {
	binary := os.Getenv("TENGRI_EDITOR_TEST_BINARY")
	if binary == "" {
		t.Skip("started by the VS Code browser acceptance runner")
	}
	home := os.Getenv("TENGRI_EDITOR_TEST_HOME")
	if home == "" {
		t.Fatal("TENGRI_EDITOR_TEST_HOME is required")
	}
	api, err := newAPIServer(apiConfig{bootstrapToken: "editor-browser-fixture", codeServerBinary: binary,
		homeRoot: home, workspaceRoot: filepath.Join(home, "workspace"), shell: "/bin/bash"})
	if err != nil {
		t.Fatal(err)
	}
	defer api.close()
	listener, err := net.Listen("tcp", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("POST /_test/shutdown", func(w http.ResponseWriter, r *http.Request) { once.Do(func() { close(done) }) })
	mux.Handle("/", newHandler(api))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	t.Log("Nanoagent editor browser fixture listening on 8080")
	<-done
}

func TestEditorStartFailureIsReportedAndRetryable(t *testing.T) {
	root := t.TempDir()
	ws, err := newWorkspace(filepath.Join(root, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	editor := newEditorSupervisor("/usr/bin/false", "", root, ws)
	defer editor.close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		var group sync.WaitGroup
		for i := 0; i < 8; i++ {
			group.Add(1)
			go func() {
				defer group.Done()
				if err := editor.ensure(ctx); err == nil || !strings.Contains(err.Error(), "stopped before") {
					t.Errorf("editor startup error = %v", err)
				}
			}()
		}
		group.Wait()
	}
}

func TestEditorPortForwardingCannotExposeGuestControlPorts(t *testing.T) {
	for _, path := range []string{"/proxy/8080/v1/files", "/absproxy/13338/", "/proxy/08080/", "/proxy/13337/", "/proxy/22/", "/proxy/host:8080/"} {
		if allowedEditorProxyPath(path) {
			t.Errorf("exposed control path %s", path)
		}
	}
	for _, path := range []string{"/", "/proxy/3000/", "/absproxy/65535/app", "/stable-revision/static/out/main.js"} {
		if !allowedEditorProxyPath(path) {
			t.Errorf("blocked application path %s", path)
		}
	}
}

func TestEditorBootstrapUsesConfiguredPersistentHome(t *testing.T) {
	root := t.TempDir()
	ws, err := newWorkspace(filepath.Join(root, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "install")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf installed > \"$HOME/editor-install-marker\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	editor := newEditorSupervisor("/usr/bin/false", script, root, ws)
	defer editor.close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := editor.ensure(ctx); err == nil {
		t.Fatal("expected placeholder executable to fail")
	}
	if data, err := os.ReadFile(filepath.Join(root, "editor-install-marker")); err != nil || string(data) != "installed" {
		t.Fatalf("installer did not use configured home: %s, %v", data, err)
	}
}

func TestEditorBootstrapDeadlineStopsInstallerChildren(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "install")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 10 &\nwait\n"), 0700); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err := bootstrapPersistentInstall(context.Background(), script, 100*time.Millisecond, "CODE_SERVER_BOOTSTRAP_COMMAND", "VS Code")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("installer deadline error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("installer child kept the request alive for %s after cancellation", elapsed)
	}
}
