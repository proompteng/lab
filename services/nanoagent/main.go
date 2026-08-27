package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	bootIDPath        = "/proc/sys/kernel/random/boot_id"
	kernelReleasePath = "/proc/sys/kernel/osrelease"
)

type evidence struct {
	Architecture  string    `json:"architecture"`
	BootID        string    `json:"bootId"`
	Hostname      string    `json:"hostname"`
	KernelRelease string    `json:"kernelRelease"`
	MicroVMID     string    `json:"microvmId"`
	StartedAt     time.Time `json:"startedAt"`
	State         string    `json:"state"`
}

type fileReader func(string) ([]byte, error)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("nanoagent stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	microVMID := strings.TrimSpace(os.Getenv("MICROVM_ID"))
	bootstrapToken, err := loadBootstrapToken()
	if err != nil {
		return err
	}
	current, err := collectEvidence(microVMID, bootstrapToken, os.ReadFile, time.Now().UTC())
	if err != nil {
		return err
	}

	encoded, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("encode startup evidence: %w", err)
	}
	logger.Info("nanoagent guest booted", "evidence", json.RawMessage(encoded))

	listenAddress := strings.TrimSpace(os.Getenv("LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = ":8080"
	}
	homeRoot, workspaceRoot := runtimeRoots(
		os.Getenv("NANOAGENT_HOME"),
		os.Getenv("NANOAGENT_WORKSPACE"),
	)
	if err := bootstrapUserHome(homeRoot); err != nil {
		return fmt.Errorf("bootstrap persistent user home: %w", err)
	}
	codexBinary := strings.TrimSpace(os.Getenv("CODEX_BINARY"))
	if codexBinary == "" {
		codexBinary = "codex"
	}

	api, err := newAPIServer(apiConfig{
		bootstrapToken: bootstrapToken,
		codexBinary:    codexBinary,
		evidence:       current,
		homeRoot:       homeRoot,
		shell:          "/bin/bash",
		startCodex:     true,
		workspaceRoot:  workspaceRoot,
	})
	if err != nil {
		return fmt.Errorf("configure Nanoagent API: %w", err)
	}
	defer api.close()

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           newHandler(api),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("nanoagent listening", "address", listenAddress)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		api.beginShutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown HTTP server: %w", err)
		}
		return nil
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	}
}

func runtimeRoots(homeRoot string, workspaceRoot string) (string, string) {
	homeRoot = strings.TrimSpace(homeRoot)
	if homeRoot == "" {
		// /workspace is the writable compatibility mount in the minimal Kata proof image.
		// Tengri sets both roots explicitly for persistent production guests.
		homeRoot = "/workspace"
	}
	workspaceRoot = strings.TrimSpace(workspaceRoot)
	if workspaceRoot == "" {
		workspaceRoot = homeRoot
	}
	return homeRoot, workspaceRoot
}

func bootstrapUserHome(home string) error {
	directories := []struct {
		path string
		mode os.FileMode
	}{
		{path: "workspace", mode: 0o750},
		{path: ".cache", mode: 0o750},
		{path: ".local/bin", mode: 0o750},
		{path: ".bun", mode: 0o750},
		{path: ".cargo", mode: 0o750},
		{path: "go/bin", mode: 0o750},
		{path: ".codex", mode: 0o700},
	}
	for _, directory := range directories {
		if err := os.MkdirAll(filepath.Join(home, directory.path), directory.mode); err != nil {
			return err
		}
	}
	files := map[string]string{
		".bashrc":  "export PATH=\"$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH\"\ncd /workspace 2>/dev/null || true\n",
		".profile": "export PATH=\"$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH\"\n",
	}
	for name, content := range files {
		path := filepath.Join(home, name)
		if _, err := os.Stat(path); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
			return err
		}
	}
	return nil
}

func collectEvidence(
	microVMID string,
	bootstrapToken string,
	readFile fileReader,
	startedAt time.Time,
) (evidence, error) {
	if microVMID == "" {
		return evidence{}, errors.New("MICROVM_ID is required")
	}
	if bootstrapToken == "" {
		return evidence{}, errors.New("bootstrap token is required")
	}

	bootID, err := readTrimmed(readFile, bootIDPath)
	if err != nil {
		return evidence{}, fmt.Errorf("read guest boot ID: %w", err)
	}
	kernelRelease, err := readTrimmed(readFile, kernelReleasePath)
	if err != nil {
		return evidence{}, fmt.Errorf("read guest kernel release: %w", err)
	}
	hostname, err := os.Hostname()
	if err != nil {
		return evidence{}, fmt.Errorf("read hostname: %w", err)
	}

	return evidence{
		Architecture:  runtime.GOARCH,
		BootID:        bootID,
		Hostname:      hostname,
		KernelRelease: kernelRelease,
		MicroVMID:     microVMID,
		StartedAt:     startedAt,
		State:         "ready",
	}, nil
}

func readTrimmed(readFile fileReader, path string) (string, error) {
	value, err := readFile(path)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(string(value))
	if trimmed == "" {
		return "", errors.New("value is empty")
	}
	return trimmed, nil
}

func newHandler(api *apiServer) http.Handler {
	mux := http.NewServeMux()
	live := func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("{\"status\":\"ok\"}\n"))
	}
	ready := func(writer http.ResponseWriter, _ *http.Request) {
		if api.codex != nil && !api.codex.isReady() {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "starting"})
			return
		}
		live(writer, nil)
	}
	mux.HandleFunc("GET /livez", live)
	mux.HandleFunc("GET /readyz", ready)
	mux.HandleFunc("GET /healthz", live)
	mux.Handle("/v1/", api.authenticatedRoutes())
	return mux
}
