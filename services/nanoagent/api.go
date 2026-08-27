package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

const (
	maxDirectoryEntries = 10_000
	maxFileBytes        = 4 << 20
	maxJSONBodyBytes    = ((maxFileBytes + 2) / 3 * 4) + (64 << 10)
)

type apiConfig struct {
	bootstrapToken string
	evidence       evidence
	workspaceRoot  string
}

type apiServer struct {
	bootstrapToken   string
	evidence         evidence
	fileWatcher      *fileWatcher
	previewTransport http.RoundTripper
	workspace        workspace
}

type apiError struct {
	Error string `json:"error"`
}

func newAPIServer(config apiConfig) (*apiServer, error) {
	if config.bootstrapToken == "" {
		return nil, errors.New("bootstrap token is required")
	}
	workspace, err := newWorkspace(config.workspaceRoot)
	if err != nil {
		return nil, err
	}

	files, err := newFileWatcher(workspace)
	if err != nil {
		_ = workspace.close()
		return nil, fmt.Errorf("watch user home: %w", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	server := &apiServer{
		bootstrapToken:   config.bootstrapToken,
		evidence:         config.evidence,
		fileWatcher:      files,
		previewTransport: transport,
		workspace:        workspace,
	}
	return server, nil
}

func (server *apiServer) close() {
	server.beginShutdown()
	_ = server.workspace.close()
}

func (server *apiServer) beginShutdown() {
	_ = server.fileWatcher.close()
}

func (server *apiServer) authenticatedRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/evidence", server.handleEvidence)
	mux.HandleFunc("GET /v1/files", server.handleListFiles)
	mux.HandleFunc("GET /v1/files/search", server.handleSearchFiles)
	mux.HandleFunc("GET /v1/files/watch", server.handleWatchFiles)
	mux.HandleFunc("GET /v1/files/content", server.handleReadFile)
	mux.HandleFunc("PUT /v1/files/content", server.handleWriteFile)
	mux.HandleFunc("POST /v1/files/directory", server.handleCreateDirectory)
	mux.HandleFunc("POST /v1/files/move", server.handleMoveFile)
	mux.HandleFunc("DELETE /v1/files", server.handleDeleteFile)
	mux.HandleFunc("/v1/preview/{port}/{path...}", server.handlePreview)

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization := request.Header.Get("Authorization")
		provided, found := strings.CutPrefix(authorization, "Bearer ")
		if !found || subtle.ConstantTimeCompare([]byte(provided), []byte(server.bootstrapToken)) != 1 {
			writer.Header().Set("WWW-Authenticate", "Bearer")
			writeAPIError(writer, http.StatusUnauthorized, "invalid Nanoagent credentials")
			return
		}
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(writer, request)
	})
}

func (server *apiServer) handleEvidence(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, server.evidence)
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid JSON request")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(writer, http.StatusBadRequest, "request must contain one JSON object")
		return false
	}
	return true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		return
	}
}

func writeAPIError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, apiError{Error: message})
}

func validatePreviewPort(port int) error {
	if port < 1024 || port > 65535 || port == 8080 {
		return fmt.Errorf("preview port must be between 1024 and 65535 and cannot be 8080")
	}
	return nil
}

func loopbackAddress(port int) string {
	return net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port))
}
