package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"

	"google.golang.org/grpc"
)

const (
	maxDirectoryEntries             = 10_000
	maxFileBytes                    = 4 << 20
	maxJSONBodyBytes                = ((maxFileBytes + 2) / 3 * 4) + (64 << 10)
	nanoagentAuthFailureHeader      = "X-Tengri-Nanoagent-Auth-Failure"
	nanoagentAuthFailureHeaderValue = "1"
)

type apiConfig struct {
	bootstrapToken      string
	codexBinary         string
	codeServerBinary    string
	codeServerBootstrap string
	evidence            evidence
	homeRoot            string
	shell               string
	startCodex          bool
	workspaceRoot       string
}

type apiServer struct {
	bootstrapToken   string
	codex            *codexSupervisor
	editor           *editorSupervisor
	evidence         evidence
	fileMutationMu   sync.RWMutex
	fileWatcher      *fileWatcher
	previewRequests  *previewRequestTracker
	previewTransport http.RoundTripper
	syncDirectories  func(workspace, ...string) error
	terminals        *terminalManager
	workspace        workspace
	rpc              *grpc.Server
}

type apiError struct {
	Error string `json:"error"`
}

func newAPIServer(config apiConfig) (*apiServer, error) {
	if config.bootstrapToken == "" {
		return nil, errors.New("bootstrap token is required")
	}
	if config.startCodex && config.codexBinary == "" {
		return nil, errors.New("Codex binary is required")
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
		previewRequests:  newPreviewRequestTracker(),
		previewTransport: transport,
		syncDirectories:  syncWorkspaceDirectories,
		terminals:        newTerminalManager(workspace, config.shell, config.homeRoot),
		workspace:        workspace,
	}
	if config.startCodex {
		server.codex = newCodexSupervisor(config.codexBinary, workspace.realRoot)
		server.codex.start()
	}
	if config.codeServerBinary != "" {
		server.editor = newEditorSupervisor(config.codeServerBinary, config.codeServerBootstrap, config.homeRoot, workspace)
	}
	server.evidence.GuestProtocolVersion = guestProtocolVersion
	server.rpc = server.newRPCServer()
	return server, nil
}

func (server *apiServer) close() {
	server.beginShutdown()
	_ = server.workspace.close()
}

func (server *apiServer) beginShutdown() {
	if server.rpc != nil {
		server.rpc.Stop()
	}
	if server.previewRequests != nil {
		server.previewRequests.close()
	}
	server.terminals.close()
	_ = server.fileWatcher.close()
	if server.codex != nil {
		server.codex.close()
	}
	if server.editor != nil {
		server.editor.close()
	}
}

func (server *apiServer) previewRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/preview/{port}/{path...}", server.handlePreview)

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization := request.Header.Get("Authorization")
		provided, found := strings.CutPrefix(authorization, "Bearer ")
		if !found || subtle.ConstantTimeCompare([]byte(provided), []byte(server.bootstrapToken)) != 1 {
			writer.Header().Set("WWW-Authenticate", "Bearer")
			writer.Header().Set(nanoagentAuthFailureHeader, nanoagentAuthFailureHeaderValue)
			writeAPIError(writer, http.StatusUnauthorized, "invalid Nanoagent credentials")
			return
		}
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(writer, request)
	})
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
	if port < 1024 || port > 65535 || port == 8080 || port == 8443 || port == editorBridgePort {
		return fmt.Errorf("preview port must be between 1024 and 65535 and cannot use a reserved guest port")
	}
	return nil
}

func loopbackAddress(port int) string {
	return net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port))
}
