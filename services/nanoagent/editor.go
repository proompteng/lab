package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const editorPort = 13337
const editorBridgePort = 13338

//go:embed vscode-extension/*
var editorExtension embed.FS

type editorRun struct {
	ready, done chan struct{}
	failure     error
}

type editorSupervisor struct {
	mu                      sync.Mutex
	ctx                     context.Context
	cancel                  context.CancelFunc
	binary, bootstrap, home string
	workspace               workspace
	running                 bool
	current                 *editorRun
	bridge                  *editorBridge
	transport               *http.Transport
}

func newEditorSupervisor(binary, bootstrap, home string, workspace workspace) *editorSupervisor {
	ctx, cancel := context.WithCancel(context.Background())
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(home, ".tengri", "vscode", "server.sock"))
	}}
	return &editorSupervisor{ctx: ctx, cancel: cancel, binary: binary, bootstrap: bootstrap, home: home,
		workspace: workspace, bridge: newEditorBridge(), transport: transport}
}

func (editor *editorSupervisor) ensure(ctx context.Context) error {
	editor.mu.Lock()
	if editor.ctx.Err() != nil {
		editor.mu.Unlock()
		return errors.New("editor is shutting down")
	}
	if !editor.running {
		editor.running = true
		editor.current = &editorRun{ready: make(chan struct{}), done: make(chan struct{})}
		go editor.run(editor.current)
	}
	run := editor.current
	editor.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-run.ready:
		editor.mu.Lock()
		defer editor.mu.Unlock()
		return run.failure
	}
}

func (editor *editorSupervisor) run(run *editorRun) {
	ready := false
	var failure error
	defer func() {
		editor.mu.Lock()
		defer editor.mu.Unlock()
		run.failure = failure
		if !ready {
			close(run.ready)
		}
		editor.running = false
		close(run.done)
	}()
	if err := bootstrapPersistentInstall(editor.ctx, editor.bootstrap, 4*time.Minute, "CODE_SERVER_BOOTSTRAP_COMMAND", "VS Code", "HOME="+editor.home); err != nil {
		failure = err
		return
	}
	dataRoot := filepath.Join(editor.home, ".tengri", "vscode")
	if err := installEditorIntegration(dataRoot); err != nil {
		failure = err
		return
	}
	listener, err := net.Listen("tcp", loopbackAddress(editorBridgePort))
	if err != nil {
		failure = fmt.Errorf("listen for VS Code integration: %w", err)
		return
	}
	bridgeServer := &http.Server{Handler: http.HandlerFunc(editor.bridge.extension), ReadHeaderTimeout: 5 * time.Second}
	defer bridgeServer.Close()
	go func() { _ = bridgeServer.Serve(listener) }()
	socketPath := filepath.Join(dataRoot, "server.sock")
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		failure = err
		return
	}
	command := exec.CommandContext(editor.ctx, editor.binary,
		"--socket", socketPath, "--socket-mode", "0700", "--auth", "none",
		"--config", filepath.Join(dataRoot, "config.yaml"),
		"--user-data-dir", filepath.Join(dataRoot, "data"), "--extensions-dir", filepath.Join(dataRoot, "extensions"),
		"--disable-telemetry", "--disable-update-check", "--disable-getting-started-override",
		editor.workspace.realRoot)
	command.Dir = editor.workspace.realRoot
	command.Env = childEnvironment("HOME="+editor.home, "TENGRI_WORKSPACE_ROOT="+editor.workspace.realRoot)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { killProcessGroup(command); return nil }
	command.WaitDelay = 5 * time.Second
	log, err := os.OpenFile(filepath.Join(dataRoot, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		failure = err
		return
	}
	defer log.Close()
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		failure = fmt.Errorf("start VS Code: %w", err)
		return
	}
	defer killProcessGroup(command)
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	client := &http.Client{Timeout: time.Second, Transport: editor.transport.Clone()}
	defer client.CloseIdleConnections()
	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for !ready {
		select {
		case err := <-exited:
			failure = fmt.Errorf("VS Code stopped before it became ready: %v", err)
			return
		case <-editor.ctx.Done():
			<-exited
			failure = editor.ctx.Err()
			return
		case <-timeout.C:
			killProcessGroup(command)
			<-exited
			failure = errors.New("VS Code did not become ready within 30 seconds; see .tengri/vscode/server.log")
			return
		case <-ticker.C:
			request, _ := http.NewRequestWithContext(editor.ctx, http.MethodGet, "http://"+loopbackAddress(editorPort)+"/healthz", nil)
			response, err := client.Do(request)
			if err == nil {
				_ = response.Body.Close()
				if response.StatusCode == http.StatusOK {
					ready = true
				}
			}
		}
	}
	editor.mu.Lock()
	close(run.ready)
	editor.mu.Unlock()
	failure = <-exited
	if failure == nil {
		failure = errors.New("VS Code exited")
	}
}

func (editor *editorSupervisor) close() {
	editor.cancel()
	editor.bridge.close()
	editor.transport.CloseIdleConnections()
	editor.mu.Lock()
	run := editor.current
	editor.mu.Unlock()
	if run != nil {
		<-run.done
	}
}

func installEditorIntegration(root string) error {
	directory := filepath.Join(root, "extensions", "proompteng.tengri-desktop-1.0.0")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	for _, name := range []string{"package.json", "extension.js"} {
		content, err := fs.ReadFile(editorExtension, "vscode-extension/"+name)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(directory, name), content, 0600); err != nil {
			return err
		}
	}
	settingsDirectory := filepath.Join(root, "data", "User")
	if err := os.MkdirAll(settingsDirectory, 0700); err != nil {
		return err
	}
	settings, err := os.OpenFile(filepath.Join(settingsDirectory, "settings.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer settings.Close()
	_, err = settings.WriteString(`{"workbench.colorTheme":"Default Dark Modern","workbench.startupEditor":"none","window.menuBarVisibility":"compact","workbench.secondarySideBar.defaultVisibility":"hidden","remote.extensionKind":{"vscode.typescript-language-features":["workspace","-web"]},"telemetry.telemetryLevel":"off","files.autoSave":"off","files.hotExit":"onExitAndWindowClose"}`)
	return err
}

func (server *apiServer) handleOpenEditor(writer http.ResponseWriter, request *http.Request) {
	if server.editor == nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "VS Code is not installed in this guest. Sleep and resume the agent to install the current guest image.")
		return
	}
	if err := server.editor.ensure(request.Context()); err != nil {
		writeAPIError(writer, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"port": editorPort})
}
