package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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
	Architecture         string    `json:"architecture"`
	BootID               string    `json:"bootId"`
	BootstrapTokenSHA256 string    `json:"bootstrapTokenSha256"`
	Hostname             string    `json:"hostname"`
	KernelRelease        string    `json:"kernelRelease"`
	MicroVMID            string    `json:"microvmId"`
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
	bootstrapToken := os.Getenv("MICROVM_BOOTSTRAP_TOKEN")
	current, err := collectEvidence(microVMID, bootstrapToken, os.ReadFile, time.Now().UTC())
	if err != nil {
		return err
	}

	encoded, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("encode startup evidence: %w", err)
	}
	logger.Info("nanoagent ready", "evidence", json.RawMessage(encoded))

	listenAddress := strings.TrimSpace(os.Getenv("LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = ":8080"
	}

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           newHandler(current),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
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
		return evidence{}, errors.New("MICROVM_BOOTSTRAP_TOKEN is required")
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

	tokenHash := sha256.Sum256([]byte(bootstrapToken))

	return evidence{
		Architecture:         runtime.GOARCH,
		BootID:               bootID,
		BootstrapTokenSHA256: hex.EncodeToString(tokenHash[:]),
		Hostname:             hostname,
		KernelRelease:        kernelRelease,
		MicroVMID:            microVMID,
		StartedAt:            startedAt,
		State:                "ready",
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

func newHandler(current evidence) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	mux.HandleFunc("GET /evidence", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(writer).Encode(current); err != nil {
			slog.Error("write evidence response", "error", err)
		}
	})
	return mux
}
