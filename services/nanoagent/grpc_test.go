package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
	server.Config.Protocols = guestHTTPProtocols()
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
	if err != nil || info.MicrovmId != "interop-agent" || info.ProtocolVersion != 1 {
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
	legacy := performAuthorizedRequest(newHandler(api), http.MethodGet, "/v1/files?path=/", nil)
	if legacy.Code != http.StatusOK {
		t.Fatalf("legacy HTTP status = %d", legacy.Code)
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
	if !ok || detail.HttpStatus != 409 || detail.CurrentRevision != written.Revision {
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
	_, address := rpcTestClient(t, api)
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
	fmt.Println("NANOAGENT_RPC_ADDR=" + address)
	_, _ = io.Copy(io.Discard, os.Stdin)
	api.beginShutdown()
}
