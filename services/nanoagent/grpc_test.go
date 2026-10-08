package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func rpcTestClient(t *testing.T, api *apiServer) (pb.NanoagentServiceClient, string) {
	t.Helper()
	api.evidence.MicroVMID = "interop-agent"
	server := httptest.NewUnstartedServer(newHandler(api))
	server.Config.Protocols = fixtureHTTPProtocols()
	server.Start()
	t.Cleanup(server.Close)
	connection, err := grpc.NewClient(server.Listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxGuestRPCBytes)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return pb.NewNanoagentServiceClient(connection), server.URL
}

func rpcTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer test-bootstrap-token")
}

func TestRPCBrowserMCPStatusReachesCodex(t *testing.T) {
	api := testAPIServer(t)
	api.codex, _ = readyCodexSupervisor(t)
	writer := api.codex.stdin.(*codexWireWriter)
	client, _ := rpcTestClient(t, api)
	ctx := rpcTestContext(t)
	type callResult struct {
		response *pb.CodexResult
		err      error
	}
	done := make(chan callResult, 1)
	go func() {
		response, err := client.CodexCall(ctx, &pb.CodexRequest{Method: "mcpServerStatus/list", ParamsJson: []byte(`{"limit":50}`)})
		done <- callResult{response: response, err: err}
	}()
	var wire []byte
	select {
	case wire = <-writer.messages:
	case result := <-done:
		t.Fatalf("MCP status was rejected before reaching Codex: %v", result.err)
	case <-ctx.Done():
		t.Fatal("MCP status did not reach Codex")
	}
	var request codexRPCMessage
	if err := json.Unmarshal(wire, &request); err != nil {
		t.Fatal(err)
	}
	if request.Method != "mcpServerStatus/list" || string(request.Params) != `{"limit":50}` {
		t.Fatalf("Codex received a different request: %s", wire)
	}
	statusJSON := json.RawMessage(`{"data":[{"name":"tengri_browser","tools":{"computer":{"name":"computer","inputSchema":{"type":"object"}}}}]}`)
	api.codex.resolveResponse(codexRPCMessage{ID: request.ID, Result: statusJSON})
	select {
	case result := <-done:
		if result.err != nil || result.response == nil || !bytes.Equal(result.response.ResultJson, statusJSON) {
			t.Fatalf("MCP status did not survive the guest RPC: %v, %v", result.response, result.err)
		}
	case <-ctx.Done():
		t.Fatal("Codex status response did not reach the RPC caller")
	}
}

func TestRPCAuthenticatesUnaryAndStreamingOnSharedHTTPPort(t *testing.T) {
	api := testAPIServer(t)
	client, address := rpcTestClient(t, api)
	ctx := rpcTestContext(t)
	for _, credentials := range [][]string{nil, {"Bearer wrong"}, {"Bearer test-bootstrap-token", "Bearer test-bootstrap-token"}} {
		unauthorized := metadata.NewOutgoingContext(ctx, metadata.MD{"authorization": credentials})
		_, err := client.WriteFile(unauthorized, &pb.FileWrite{Path: "/denied", ExpectedRevision: "missing", Content: []byte("denied")})
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("unary authentication: %v", err)
		}
		stream, err := client.WatchFiles(unauthorized, &pb.FileWatch{Path: "/"})
		if err == nil {
			_, err = stream.Recv()
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("stream authentication: %v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(api.workspace.root, "denied")); !os.IsNotExist(err) {
		t.Fatalf("unauthorized request mutated workspace: %v", err)
	}
	info, err := client.GetInfo(ctx, &pb.Empty{})
	if err != nil || info.MicrovmId != "interop-agent" || info.ProtocolVersion != guestProtocolVersion {
		t.Fatalf("authenticated info = %v, %v", info, err)
	}
	response, err := http.Get(address + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("HTTP health status = %d", response.StatusCode)
	}
	for _, route := range []struct{ method, path string }{
		{"GET", "/v1/evidence"}, {"POST", "/v1/editor"},
		{"GET", "/v1/files"}, {"GET", "/v1/files/search"}, {"GET", "/v1/files/watch"},
		{"GET", "/v1/files/content"}, {"PUT", "/v1/files/content"}, {"POST", "/v1/files/directory"}, {"POST", "/v1/files/move"}, {"DELETE", "/v1/files"},
		{"POST", "/v1/terminals"}, {"GET", "/v1/terminals"}, {"DELETE", "/v1/terminals/id"}, {"GET", "/v1/terminals/id/ws"},
		{"POST", "/v1/codex/call"}, {"GET", "/v1/codex/login"}, {"GET", "/v1/codex/events"}, {"POST", "/v1/codex/approvals/id"},
	} {
		request, err := http.NewRequestWithContext(ctx, route.method, address+route.path, bytes.NewBufferString(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer test-bootstrap-token")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("removed route %s %s returned %d", route.method, route.path, response.StatusCode)
		}
	}

}

func TestRPCFileBytesRevisionAndConfinement(t *testing.T) {
	api := testAPIServer(t)
	client, _ := rpcTestClient(t, api)
	ctx := rpcTestContext(t)
	content := bytes.Repeat([]byte{0, 255, 1, 128}, maxFileBytes/4)
	written, err := client.WriteFile(ctx, &pb.FileWrite{Path: "/binary.dat", ExpectedRevision: "missing", Content: content})
	if err != nil {
		t.Fatal(err)
	}
	read, err := client.ReadFile(ctx, &pb.Path{Path: "/binary.dat"})
	if err != nil || !bytes.Equal(read.Content, content) || read.Revision != written.Revision {
		t.Fatalf("binary round trip: %v", err)
	}
	_, err = client.WriteFile(ctx, &pb.FileWrite{Path: "/binary.dat", ExpectedRevision: "missing", Content: []byte("stale")})
	conflict := status.Convert(err)
	if conflict.Code() != codes.Aborted || len(conflict.Details()) != 1 {
		t.Fatalf("revision conflict: %v", err)
	}
	detail, ok := conflict.Details()[0].(*pb.OperationFailure)
	if !ok || detail.CurrentRevision != written.Revision {
		t.Fatalf("revision conflict details = %v", conflict.Details())
	}
	for _, path := range []string{"/.tengri/private", "/.codex/private"} {
		if _, err := client.ReadFile(ctx, &pb.Path{Path: path}); status.Code(err) != codes.NotFound {
			t.Fatalf("hidden path %s: %v", path, err)
		}
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(api.workspace.root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListFiles(ctx, &pb.Path{Path: "/escape"}); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("symlink confinement: %v", err)
	}
	if _, err := client.WriteFile(ctx, &pb.FileWrite{Path: "/oversized", ExpectedRevision: "missing", Content: append(content, 0)}); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("file size limit: %v", err)
	}
}

func TestRPCSubscriptionsReplayCancelAndShutdown(t *testing.T) {
	api := testAPIServer(t)
	api.codex = newCodexSupervisor("/usr/bin/false", api.workspace.root)
	client, _ := rpcTestClient(t, api)
	ctx, cancel := context.WithCancel(rpcTestContext(t))
	api.fileWatcher.publish(fileEvent{Kind: "created", Path: "/before"})
	zero := uint64(0)
	replay, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/", After: &zero})
	if err != nil {
		t.Fatal(err)
	}
	before, err := replay.Recv()
	if err != nil || before.Path != "/before" {
		t.Fatalf("file replay: %v, %v", before, err)
	}
	tail, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tail.Header(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := tail.Recv()
	if err != nil || snapshot.Kind != "reset" || snapshot.Sequence != before.Sequence {
		t.Fatalf("file snapshot cursor: %v, %v", snapshot, err)
	}
	api.fileWatcher.publish(fileEvent{Kind: "modified", Path: "/after"})
	after, err := tail.Recv()
	if err != nil || after.Path != "/after" || after.Sequence <= before.Sequence {
		t.Fatalf("file tail: %v, %v", after, err)
	}
	api.codex.publish("item/agentMessage/delta", "", json.RawMessage(`{"params":{"integer":9007199254740993}}`))
	codex, err := client.WatchCodexEvents(ctx, &pb.CodexWatch{})
	if err != nil {
		t.Fatal(err)
	}
	event, err := codex.Recv()
	if err != nil || event.Sequence != 1 || string(event.RawJson) != `{"params":{"integer":9007199254740993}}` {
		t.Fatalf("Codex replay: %v, %v", event, err)
	}
	cancel()
	deadline := time.Now().Add(3 * time.Second)
	for {
		api.fileWatcher.mu.Lock()
		files := len(api.fileWatcher.subscriptions)
		api.fileWatcher.mu.Unlock()
		api.codex.mu.Lock()
		events := len(api.codex.subscriptions)
		api.codex.mu.Unlock()
		if files+events == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("canceled subscriptions retained: files=%d Codex=%d", files, events)
		}
		time.Sleep(10 * time.Millisecond)
	}
	shutdown, err := client.WatchFiles(rpcTestContext(t), &pb.FileWatch{Path: "/"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shutdown.Header(); err != nil {
		t.Fatal(err)
	}
	if _, err := shutdown.Recv(); err != nil {
		t.Fatal(err)
	}
	api.beginShutdown()
	if _, err := shutdown.Recv(); err == nil {
		t.Fatal("shutdown left stream active")
	}
}

// Launched explicitly by the Rust wire test. Closing stdin gracefully closes
// the service and its PTYs, including when the Rust test fails.
func TestRPCInteropServer(t *testing.T) {
	if os.Getenv("NANOAGENT_RPC_INTEROP") != "1" {
		t.Skip("fixture for Rust-to-Go integration test")
	}
	api := testAPIServer(t)
	api.codex, _ = readyCodexSupervisor(t)
	writer := api.codex.stdin.(*codexWireWriter)
	api.codex.publish("item/agentMessage/delta", "", json.RawMessage(`{"params":{"integer":9007199254740993}}`))
	api.codex.activeLoginID = "interop-login"
	api.codex.activeLogin = json.RawMessage(`{"loginId":"interop-login"}`)
	api.codex.loginStartedAt = time.Now()
	api.codex.loginGeneration = api.codex.generation
	fixture := newWorkloadFixture(t)
	server := secureRPCTestServer(t, api, fixture)
	address := server.URL
	preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("preview leaked the bootstrap credential to the application")
		}
		if r.URL.Path != "/ws" {
			_, _ = fmt.Fprint(w, "preview-over-mtls")
			return
		}
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "fixture complete")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		kind, message, err := connection.Read(ctx)
		if err != nil {
			t.Error(err)
			return
		}
		if err := connection.Write(ctx, kind, append([]byte("guest:"), message...)); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(preview.Close)
	previewURL, err := url.Parse(preview.URL)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case wire := <-writer.messages:
				var request codexRPCMessage
				if err := json.Unmarshal(wire, &request); err != nil {
					return
				}
				api.codex.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{"integer":9007199254740993}`)})
			case <-done:
				return
			}
		}
	}()
	encoded, err := json.Marshal(map[string]string{"address": address, "workloadEndpoint": fixture.endpoint, "previewPort": previewURL.Port()})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("NANOAGENT_RPC_ENDPOINT=" + string(encoded))
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		if scanner.Text() == "rotate" {
			fixture.rotate(t)
		}
	}
	api.beginShutdown()
}

func fixtureHTTPProtocols() *http.Protocols {
	protocols := guestHTTPProtocols()
	protocols.SetUnencryptedHTTP2(true)
	return protocols
}
