package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const browserPort = 13339

//go:embed browser-client.html
var browserClient []byte

//go:embed browser-client.js
var browserClientScript []byte

type browserRun struct {
	ready, done chan struct{}
	failure     error
}

type browserSupervisor struct {
	mu                      sync.Mutex
	ctx                     context.Context
	cancel                  context.CancelFunc
	binary, bootstrap, home string
	assets, downloads       string
	current                 *browserRun
	running                 bool
	cuaMu                   sync.Mutex
	userControl             bool
	control                 *http.Server
}

func newBrowserSupervisor(binary, bootstrap, home, downloads, assets string) *browserSupervisor {
	ctx, cancel := context.WithCancel(context.Background())
	browser := &browserSupervisor{ctx: ctx, cancel: cancel, binary: binary, bootstrap: bootstrap, home: home, downloads: downloads, assets: assets}
	data, err := os.ReadFile(filepath.Join(home, ".tengri", "browser", "user-control"))
	if err == nil {
		browser.userControl = string(data) != "false\n"
	} else if !errors.Is(err, os.ErrNotExist) {
		browser.userControl = true
	}
	return browser
}

func (browser *browserSupervisor) ensure(ctx context.Context) error {
	browser.mu.Lock()
	if browser.ctx.Err() != nil {
		browser.mu.Unlock()
		return errors.New("browser is shutting down")
	}
	if !browser.running {
		browser.running = true
		browser.current = &browserRun{ready: make(chan struct{}), done: make(chan struct{})}
		go browser.run(browser.current)
	}
	run := browser.current
	browser.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-run.ready:
		browser.mu.Lock()
		defer browser.mu.Unlock()
		return run.failure
	}
}

func (browser *browserSupervisor) run(run *browserRun) {
	ready := false
	var failure error
	defer func() {
		browser.mu.Lock()
		defer browser.mu.Unlock()
		run.failure = failure
		if !ready {
			close(run.ready)
		}
		browser.running = false
		close(run.done)
	}()
	if err := bootstrapPersistentInstall(browser.ctx, browser.bootstrap, 4*time.Minute, "BROWSER_BOOTSTRAP_COMMAND", "Chromium", "HOME="+browser.home); err != nil {
		failure = err
		return
	}
	root := filepath.Join(browser.home, ".tengri", "browser")
	if err := os.MkdirAll(root, 0700); err != nil {
		failure = err
		return
	}
	readyPath := filepath.Join(root, "ready")
	if err := os.Remove(readyPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		failure = err
		return
	}
	command := exec.CommandContext(browser.ctx, browser.binary)
	command.Env = childEnvironment("HOME="+browser.home, "TENGRI_BROWSER_DOWNLOADS="+browser.downloads)
	command.Dir = browser.home
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 5 * time.Second
	log, err := os.OpenFile(filepath.Join(root, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		failure = err
		return
	}
	defer log.Close()
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		failure = fmt.Errorf("start Chromium: %w", err)
		return
	}
	defer killProcessGroup(command)
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for !ready {
		select {
		case err := <-exited:
			failure = fmt.Errorf("Chromium exited before becoming ready: %v; see .tengri/browser/server.log", err)
			return
		case <-browser.ctx.Done():
			<-exited
			failure = browser.ctx.Err()
			return
		case <-timeout.C:
			killProcessGroup(command)
			<-exited
			failure = errors.New("Chromium did not become ready within 30 seconds; see .tengri/browser/server.log")
			return
		case <-ticker.C:
			if _, err := os.Stat(readyPath); err == nil {
				connection, err := net.DialTimeout("unix", filepath.Join(root, "rfb.sock"), time.Second)
				if err == nil {
					_ = connection.Close()
					ready = true
				}
			}
		}
	}
	browser.mu.Lock()
	close(run.ready)
	browser.mu.Unlock()
	failure = <-exited
	if failure == nil {
		failure = errors.New("Chromium exited")
	}
}

func (browser *browserSupervisor) close() {
	browser.cancel()
	if browser.control != nil {
		_ = browser.control.Close()
	}
	browser.mu.Lock()
	run := browser.current
	browser.mu.Unlock()
	if run != nil {
		<-run.done
	}
}

func (browser *browserSupervisor) serve(writer http.ResponseWriter, request *http.Request, path string) {
	if path == "/paste" {
		if request.Method != http.MethodPost {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var value struct {
			Text string `json:"text"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxComputerRequestBytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil || validateComputerAction(computerAction{Action: "type", Text: value.Text}) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid clipboard text")
			return
		}
		browser.cuaMu.Lock()
		defer browser.cuaMu.Unlock()
		ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
		defer cancel()
		if err := browser.ensure(ctx); err != nil {
			writeAPIError(writer, http.StatusServiceUnavailable, err.Error())
			return
		}
		clipboard := exec.CommandContext(ctx, browser.program("xclip"), "-selection", "clipboard", "-in")
		clipboard.Env = browser.environment()
		clipboard.Stdin = strings.NewReader(value.Text)
		if err := clipboard.Run(); err != nil {
			writeAPIError(writer, http.StatusServiceUnavailable, "Could not update browser clipboard")
			return
		}
		if err := browser.input(ctx, "key", "--clearmodifiers", "ctrl+v"); err != nil {
			writeAPIError(writer, http.StatusServiceUnavailable, err.Error())
			return
		}
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if path == "/control" {
		browser.cuaMu.Lock()
		defer browser.cuaMu.Unlock()
		if request.Method == http.MethodPost {
			var value struct {
				UserControl bool `json:"userControl"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 256)).Decode(&value); err != nil {
				writeAPIError(writer, http.StatusBadRequest, "invalid browser control")
				return
			}
			path := filepath.Join(browser.home, ".tengri", "browser", "user-control")
			if err := os.WriteFile(path+".tmp", []byte(fmt.Sprintf("%t\n", value.UserControl)), 0600); err != nil {
				writeAPIError(writer, http.StatusInternalServerError, "Could not save browser control")
				return
			}
			if err := os.Rename(path+".tmp", path); err != nil {
				writeAPIError(writer, http.StatusInternalServerError, "Could not save browser control")
				return
			}
			browser.userControl = value.UserControl
		} else if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(writer).Encode(map[string]bool{"userControl": browser.userControl})
		return
	}
	if path == "/websockify" {
		browser.connect(writer, request)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	if path == "/browser.js" {
		writer.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		if request.Method == http.MethodGet {
			_, _ = writer.Write(browserClientScript)
		}
		return
	}
	if path == "/" {
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.WriteHeader(http.StatusOK)
		if request.Method == http.MethodGet {
			_, _ = writer.Write(browserClient)
		}
		return
	}
	if !strings.HasPrefix(path, "/novnc/core/") && !strings.HasPrefix(path, "/novnc/vendor/") {
		http.NotFound(writer, request)
		return
	}
	clone := request.Clone(request.Context())
	clone.URL.Path = strings.TrimPrefix(path, "/novnc")
	http.FileServer(http.Dir(browser.assets)).ServeHTTP(writer, clone)
}

func (browser *browserSupervisor) connect(writer http.ResponseWriter, request *http.Request) {
	remote, err := (&net.Dialer{Timeout: time.Second}).DialContext(request.Context(), "unix", filepath.Join(browser.home, ".tengri", "browser", "rfb.sock"))
	if err != nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "Chromium is unavailable; reopen Chrome to reconnect")
		return
	}
	defer remote.Close()
	// Tengri checks the browser Origin and owner grant before forwarding over mTLS.
	client, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"binary"}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer client.CloseNow()
	client.SetReadLimit(1 << 20)
	wire := websocket.NetConn(request.Context(), client, websocket.MessageBinary)
	fromGuest := make(chan struct{})
	go func() {
		defer close(fromGuest)
		defer client.CloseNow()
		_, _ = io.Copy(wire, remote)
	}()
	_, _ = io.Copy(remote, wire)
	_ = remote.Close()
	<-fromGuest
}
