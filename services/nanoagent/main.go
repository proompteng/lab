package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	bootIDPath                = "/proc/sys/kernel/random/boot_id"
	codexBootstrapTimeout     = 9 * time.Minute
	kernelReleasePath         = "/proc/sys/kernel/osrelease"
	maxBootstrapOutputBytes   = 4 << 10
	toolchainBootstrapTimeout = 2 * time.Minute
	developerBootstrapTimeout = 15 * time.Minute
)

type evidence struct {
	Architecture         string    `json:"architecture"`
	BootID               string    `json:"bootId"`
	Hostname             string    `json:"hostname"`
	KernelRelease        string    `json:"kernelRelease"`
	MicroVMID            string    `json:"microvmId"`
	GuestProtocolVersion uint32    `json:"guestProtocolVersion"`
	StartedAt            time.Time `json:"startedAt"`
	State                string    `json:"state"`
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
	homeRoot, workspaceRoot := runtimeRoots(
		os.Getenv("NANOAGENT_HOME"),
		os.Getenv("NANOAGENT_WORKSPACE"),
	)
	if err := bootstrapUserHome(homeRoot); err != nil {
		return fmt.Errorf("bootstrap persistent user home: %w", err)
	}
	identity, err := startGuestIdentity(context.Background(), microVMID, logger)
	if err != nil {
		return err
	}
	defer identity.close()
	tlsConfig, err := identity.tlsConfig()
	if err != nil {
		return fmt.Errorf("configure SPIFFE TLS: %w", err)
	}
	if err := configureToolchainEnvironment(homeRoot); err != nil {
		return fmt.Errorf("configure persistent toolchain environment: %w", err)
	}
	if err := bootstrapToolchain(
		context.Background(),
		os.Getenv("TOOLCHAIN_BOOTSTRAP_COMMAND"),
		toolchainBootstrapTimeout,
	); err != nil {
		return err
	}
	if err := bootstrapPersistentInstall(context.Background(), os.Getenv("DEVELOPER_TOOLS_BOOTSTRAP_COMMAND"),
		developerBootstrapTimeout, "DEVELOPER_TOOLS_BOOTSTRAP_COMMAND", "developer tools"); err != nil {
		return err
	}
	if err := bootstrapCodex(
		context.Background(),
		os.Getenv("CODEX_BOOTSTRAP_COMMAND"),
		codexBootstrapTimeout,
	); err != nil {
		return err
	}
	current, err := collectEvidence(microVMID, bootstrapToken, os.ReadFile, time.Now().UTC())
	if err != nil {
		return err
	}
	current.GuestProtocolVersion = guestProtocolVersion

	encoded, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("encode startup evidence: %w", err)
	}
	logger.Info("nanoagent guest booted", "evidence", json.RawMessage(encoded))

	listenAddress := strings.TrimSpace(os.Getenv("LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = ":8443"
	}
	codexBinary := strings.TrimSpace(os.Getenv("CODEX_BINARY"))
	if codexBinary == "" {
		codexBinary = "codex"
	}

	api, err := newAPIServer(apiConfig{
		bootstrapToken:      bootstrapToken,
		identity:            identity,
		codeServerBinary:    os.Getenv("CODE_SERVER_BINARY"),
		codeServerBootstrap: os.Getenv("CODE_SERVER_BOOTSTRAP_COMMAND"),
		codexBinary:         codexBinary,
		evidence:            current,
		homeRoot:            homeRoot,
		shell:               "/bin/bash",
		startCodex:          true,
		workspaceRoot:       workspaceRoot,
	})
	if err != nil {
		return fmt.Errorf("configure Nanoagent API: %w", err)
	}
	defer api.close()

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           newHandler(api),
		Protocols:         guestHTTPProtocols(),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	healthAddress := strings.TrimSpace(os.Getenv("HEALTH_LISTEN_ADDRESS"))
	if healthAddress == "" {
		healthAddress = ":8080"
	}
	health := &http.Server{Addr: healthAddress, Handler: newHealthHandler(api), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
	serverErrors := make(chan error, 2)
	go func() {
		logger.Info("nanoagent listening", "address", listenAddress)
		serverErrors <- server.ListenAndServeTLS("", "")
	}()

	go func() { serverErrors <- health.ListenAndServe() }()
	defer health.Close()
	defer server.Close()
	select {
	case err := <-identity.exited:
		return fmt.Errorf("SPIRE agent exited: %v", err)
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

func bootstrapCodex(ctx context.Context, command string, timeout time.Duration) error {
	return bootstrapPersistentInstall(ctx, command, timeout, "CODEX_BOOTSTRAP_COMMAND", "Codex")
}

func bootstrapToolchain(ctx context.Context, command string, timeout time.Duration) error {
	return bootstrapPersistentInstall(ctx, command, timeout, "TOOLCHAIN_BOOTSTRAP_COMMAND", "toolchain")
}

func bootstrapPersistentInstall(
	ctx context.Context,
	command string,
	timeout time.Duration,
	environmentKey string,
	component string,
	extraEnvironment ...string,
) error {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	if !filepath.IsAbs(command) {
		return fmt.Errorf("%s must be an absolute path", environmentKey)
	}
	if timeout <= 0 {
		return fmt.Errorf("%s bootstrap timeout must be positive", component)
	}

	bootstrapCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	process := exec.CommandContext(bootstrapCtx, command, "--install-only")
	process.Env = childEnvironment(extraEnvironment...)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	process.Cancel = func() error { killProcessGroup(process); return nil }
	process.WaitDelay = 5 * time.Second
	output, err := process.CombinedOutput()
	if err == nil {
		return nil
	}
	if errors.Is(bootstrapCtx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("bootstrap persistent %s install: timed out", component)
	}

	message := strings.TrimSpace(string(output))
	if len(message) > maxBootstrapOutputBytes {
		message = message[:maxBootstrapOutputBytes] + "..."
	}
	if message == "" {
		return fmt.Errorf("bootstrap persistent %s install: %w", component, err)
	}
	return fmt.Errorf("bootstrap persistent %s install: %w: %s", component, err, message)
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

func configureToolchainEnvironment(home string) error {
	if !filepath.IsAbs(home) {
		return errors.New("toolchain home must be an absolute path")
	}

	prefix := filepath.Join(home, ".local")
	brew := filepath.Join(home, ".linuxbrew")
	path := prependPath(filepath.Join(brew, "sbin"), os.Getenv("PATH"))
	path = prependPath(filepath.Join(brew, "bin"), path)
	path = prependPath(filepath.Join(prefix, "bin"), path)
	for key, value := range map[string]string{
		"BUN_INSTALL":         prefix,
		"NPM_CONFIG_PREFIX":   prefix,
		"PATH":                path,
		"HOMEBREW_PREFIX":     brew,
		"HOMEBREW_CELLAR":     filepath.Join(brew, "Cellar"),
		"HOMEBREW_REPOSITORY": filepath.Join(brew, "Homebrew"),
	} {
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set %s: %w", key, err)
		}
	}
	for _, key := range []string{"EDITOR", "VISUAL"} {
		if os.Getenv(key) == "" {
			value := "nvim"
			if key == "VISUAL" {
				value = os.Getenv("EDITOR")
			}
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}

	return nil
}

func prependPath(entry string, existing string) string {
	paths := make([]string, 0, len(filepath.SplitList(existing))+1)
	seen := make(map[string]struct{})
	for _, path := range append([]string{entry}, filepath.SplitList(existing)...) {
		if path == "" {
			continue
		}
		if _, duplicate := seen[path]; duplicate {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	return strings.Join(paths, string(os.PathListSeparator))
}

func bootstrapUserHome(home string) error {
	directories := []struct {
		path string
		mode os.FileMode
	}{
		{path: "workspace", mode: 0o750},
		{path: ".cache", mode: 0o750},
		{path: ".cache/apt/lists", mode: 0o750},
		{path: ".cache/apt/archives", mode: 0o750},
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
	toolchainProfile := "export BUN_INSTALL=\"$HOME/.local\"\n" +
		"export NPM_CONFIG_PREFIX=\"$HOME/.local\"\n" +
		"export PATH=\"$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH\"\n" +
		"if [ -f /etc/profile.d/tengri-development.sh ]; then . /etc/profile.d/tengri-development.sh; fi\n"
	files := map[string]string{
		".bashrc":  toolchainProfile + "cd /workspace 2>/dev/null || true\n",
		".profile": toolchainProfile,
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

func newHealthHandler(api *apiServer) http.Handler {
	mux := http.NewServeMux()
	live := func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("{\"status\":\"ok\"}\n"))
	}
	ready := func(writer http.ResponseWriter, _ *http.Request) {
		if (api.codex != nil && !api.codex.isReady()) || (api.identity != nil && !api.identity.ready()) {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "starting"})
			return
		}
		live(writer, nil)
	}
	mux.HandleFunc("GET /livez", live)
	mux.HandleFunc("GET /readyz", ready)
	mux.HandleFunc("GET /healthz", live)
	return mux
}

func newHandler(api *apiServer) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", newHealthHandler(api))
	mux.Handle("/v1/", api.previewRoutes())
	return api.rpcHandler(mux)
}
