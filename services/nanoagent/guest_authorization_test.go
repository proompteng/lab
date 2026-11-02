package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/proompteng/lab/services/nanoagent/internal/guestauth"
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

var fixtureGuestClaim = guestauth.RuntimeClaim{
	WorkspaceUID: "11111111-1111-4111-8111-111111111111",
	RuntimeEpoch: "22222222-2222-4222-8222-222222222222",
	SlotEpoch:    7,
	PodUID:       "33333333-3333-4333-8333-333333333333",
}

func fixtureGuestKey() ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func fixtureGuestAuthorization(t *testing.T) *guestRPCAdmission {
	t.Helper()
	admission, err := guestauth.NewAdmission(fixtureGuestKey().Public().(ed25519.PublicKey), 10000)
	if err != nil {
		t.Fatal(err)
	}
	return &guestRPCAdmission{admission: admission, recoveryGeneration: 1, claim: func() (guestauth.RuntimeClaim, error) { return fixtureGuestClaim, nil }}
}

func TestGuestRecoveryGenerationRequiresCanonicalPositiveInteger(t *testing.T) {
	for _, value := range []string{"", "0", "01", " 1", "1 ", "1\n\n", "-1", "+1", "9223372036854775808"} {
		if _, err := decodeGuestRecoveryGeneration([]byte(value)); err == nil {
			t.Fatalf("invalid recovery generation %q accepted", value)
		}
	}
	for _, value := range []string{"1", "2\n", "9223372036854775807"} {
		if _, err := decodeGuestRecoveryGeneration([]byte(value)); err != nil {
			t.Fatalf("canonical recovery generation %q rejected: %v", value, err)
		}
	}
}

func TestGuestAuthorityStagesOnlyPublicKeyAndRecoveryGeneration(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires guest root; included in the native Linux fixture")
	}
	directory := t.TempDir()
	claimPath := filepath.Join(directory, "claim.json")
	if err := os.WriteFile(claimPath, []byte("old claim"), 0644); err != nil {
		t.Fatal(err)
	}
	key := fixtureGuestKey().Public().(ed25519.PublicKey)
	if err := prepareGuestAuthority(directory, key, 7); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(claimPath); !os.IsNotExist(err) {
		t.Fatalf("old claim survived staging: %v", err)
	}
	contents, err := readGuestRootFile(filepath.Join(directory, "guest-verify.pub"), 32)
	if err != nil || !bytes.Equal(contents, key) {
		t.Fatalf("staged public key: %v", err)
	}
	contents, err = readGuestRootFile(filepath.Join(directory, "recovery-generation"), 20)
	if err != nil || string(contents) != "7" {
		t.Fatalf("staged recovery generation %q: %v", contents, err)
	}
	if err := prepareGuestAuthority(directory, key, 0); err == nil {
		t.Fatal("missing recovery generation accepted")
	}
}

func TestRPCUsesInstalledRecoveryGenerationBeforeMutation(t *testing.T) {
	api := testAPIServer(t)
	api.guestAuthorization.recoveryGeneration = 2
	client := unsignedRPCTestClient(t, api)
	request := &pb.FileWrite{Path: "/workspace/recovered", ExpectedRevision: "missing", Content: []byte("new generation")}
	oldContext, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WriteFile_FullMethodName, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.WriteFile(oldContext, request); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("old recovery generation admitted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(api.workspace.root, "recovered")); !os.IsNotExist(err) {
		t.Fatalf("old recovery generation reached filesystem: %v", err)
	}
	currentContext, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WriteFile_FullMethodName, request, func(c *guestauth.Context) { c.RecoveryGeneration = 2 })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.WriteFile(currentContext, request); err != nil {
		t.Fatalf("installed recovery generation denied: %v", err)
	}
}

func signedFixtureRPCContext(ctx context.Context, method string, value any, change func(*guestauth.Context)) (context.Context, error) {
	message, ok := value.(proto.Message)
	if !ok {
		return nil, errors.New("fixture RPC requires protobuf")
	}
	body, err := proto.MarshalOptions{Deterministic: true}.Marshal(message)
	if err != nil {
		return nil, err
	}
	action, err := guestauth.RPCAction(method)
	if err != nil {
		return nil, err
	}
	target, err := guestRPCTarget(method, message)
	if err != nil {
		return nil, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	nonce[6], nonce[8] = (nonce[6]&15)|64, (nonce[8]&63)|128
	id := hex.EncodeToString(nonce[:])
	now := uint64(time.Now().UnixMilli())
	claim := fixtureGuestClaim
	proof := guestauth.Context{ProtocolVersion: guestauth.ProtocolVersion,
		Actor:  guestauth.Actor{Kind: "human", Subject: strings.Repeat("a", 64), SessionID: "44444444-4444-4444-8444-444444444444"},
		Action: action, WorkspaceUID: claim.WorkspaceUID, RuntimeEpoch: claim.RuntimeEpoch, SlotEpoch: claim.SlotEpoch, PodUID: claim.PodUID,
		LeaderOwner: "55555555-5555-4555-8555-555555555555", LeaderGeneration: 2, RecoveryGeneration: 1,
		AuditReceiptID: "66666666-6666-4666-8666-666666666666", Method: method, Target: target, BodySHA256: guestauth.BodySHA256(body),
		IssuedAtUnixMS: now, DeadlineUnixMS: now + 5000, Nonce: id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]}
	if change != nil {
		change(&proof)
	}
	payload, err := json.Marshal(proof)
	if err != nil {
		return nil, err
	}
	signature := ed25519.Sign(fixtureGuestKey(), append([]byte("tengri-guest-request-v4\x00"), payload...))
	values, _ := metadata.FromOutgoingContext(ctx)
	values = values.Copy()
	values.Set(guestauth.ContextHeader, base64.RawURLEncoding.EncodeToString(payload))
	values.Set(guestauth.SignatureHeader, base64.RawURLEncoding.EncodeToString(signature))
	values.Set(guestClaimUIDHeader, claim.WorkspaceUID)
	values.Set(guestClaimEpochHeader, strconv.FormatUint(claim.SlotEpoch, 10))
	values.Set(guestRuntimeEpochHeader, claim.RuntimeEpoch)
	return metadata.NewOutgoingContext(ctx, values), nil
}

func fixtureRPCDialOptions() []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, connection *grpc.ClientConn, invoke grpc.UnaryInvoker, options ...grpc.CallOption) error {
			ctx, err := signedFixtureRPCContext(ctx, method, req, nil)
			if err != nil {
				return err
			}
			return invoke(ctx, method, req, reply, connection, options...)
		}),
		grpc.WithStreamInterceptor(func(ctx context.Context, description *grpc.StreamDesc, connection *grpc.ClientConn, method string, create grpc.Streamer, options ...grpc.CallOption) (grpc.ClientStream, error) {
			return &fixtureSignedClientStream{ctx: ctx, open: func(value any) (grpc.ClientStream, error) {
				ctx, err := signedFixtureRPCContext(ctx, method, value, nil)
				if err != nil {
					return nil, err
				}
				return create(ctx, description, connection, method, options...)
			}}, nil
		}),
	}
}

type fixtureSignedClientStream struct {
	grpc.ClientStream
	ctx  context.Context
	open func(any) (grpc.ClientStream, error)
}

func (stream *fixtureSignedClientStream) Context() context.Context { return stream.ctx }
func (stream *fixtureSignedClientStream) SendMsg(value any) error {
	if stream.ClientStream == nil {
		opened, err := stream.open(value)
		if err != nil {
			return err
		}
		stream.ClientStream = opened
	}
	return stream.ClientStream.SendMsg(value)
}

func unsignedRPCTestClient(t *testing.T, api *apiServer) pb.NanoagentServiceClient {
	t.Helper()
	_, address := rpcTestClient(t, api)
	connection, err := grpc.NewClient(strings.TrimPrefix(address, "http://"), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return pb.NewNanoagentServiceClient(connection)
}

func TestRPCBootstrapTokenCannotReplaceSignedAuthorization(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	ctx := rpcTestContext(t)
	if _, err := client.GetInfo(ctx, &pb.Empty{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("bootstrap token admitted an unsigned metadata request: %v", err)
	}
	if _, err := client.WriteFile(ctx, &pb.FileWrite{Path: "/workspace/unsigned", Content: []byte("denied"), ExpectedRevision: "missing"}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("bootstrap token admitted an unsigned mutation: %v", err)
	}
	stream, err := client.WatchFiles(ctx, &pb.FileWatch{Path: "/workspace"})
	if err == nil {
		_, err = stream.Recv()
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("bootstrap token admitted an unsigned watch: %v", err)
	}
	if _, err := os.Stat(filepath.Join(api.workspace.root, "unsigned")); !os.IsNotExist(err) {
		t.Fatalf("unsigned mutation reached the filesystem: %v", err)
	}
}

func TestRPCRejectsSignedRequestsForDifferentBindingsBeforeMutation(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	request := &pb.FileWrite{Path: "/workspace/bound", ExpectedRevision: "missing", Content: []byte("authorized")}
	for _, test := range []struct {
		name   string
		change func(*guestauth.Context)
	}{
		{"workspace", func(c *guestauth.Context) { c.WorkspaceUID = "77777777-7777-4777-8777-777777777777" }},
		{"runtime", func(c *guestauth.Context) { c.RuntimeEpoch = "77777777-7777-4777-8777-777777777777" }},
		{"slot", func(c *guestauth.Context) { c.SlotEpoch++ }},
		{"pod", func(c *guestauth.Context) { c.PodUID = "77777777-7777-4777-8777-777777777777" }},
		{"recovery", func(c *guestauth.Context) { c.RecoveryGeneration++ }},
		{"action", func(c *guestauth.Context) { c.Action = guestauth.TerminalControl }},
		{"method", func(c *guestauth.Context) { c.Method = pb.NanoagentService_CreateDirectory_FullMethodName }},
		{"target", func(c *guestauth.Context) { c.Target = "/workspace/different" }},
		{"body", func(c *guestauth.Context) { c.BodySHA256 = strings.Repeat("0", 64) }},
		{"expired", func(c *guestauth.Context) { c.IssuedAtUnixMS -= 10000; c.DeadlineUnixMS -= 10000 }},
		{"retired protocol", func(c *guestauth.Context) { c.ProtocolVersion = 3 }},
		{"future protocol", func(c *guestauth.Context) { c.ProtocolVersion = guestauth.ProtocolVersion + 1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WriteFile_FullMethodName, request, test.change)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.WriteFile(ctx, request); status.Code(err) != codes.Unauthenticated {
				t.Fatalf("different %s was admitted: %v", test.name, err)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(api.workspace.root, "bound")); !os.IsNotExist(err) {
		t.Fatalf("denied request reached the filesystem: %v", err)
	}
	ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WriteFile_FullMethodName, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.WriteFile(ctx, &pb.FileWrite{Path: request.Path, ExpectedRevision: "missing", Content: []byte("tampered")}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("changed payload admitted: %v", err)
	}
	if _, err := client.WriteFile(ctx, request); err != nil {
		t.Fatalf("invalid binding consumed the valid proof: %v", err)
	}
	if _, err := client.WriteFile(ctx, request); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("replayed mutation admitted: %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(api.workspace.root, "bound"))
	if err != nil || string(contents) != "authorized" {
		t.Fatalf("authorized mutation = %q, %v", contents, err)
	}
}

func TestRPCRequiresExactlyOneProofAndClaimHeader(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	for _, header := range []string{guestauth.ContextHeader, guestauth.SignatureHeader, guestClaimUIDHeader, guestClaimEpochHeader, guestRuntimeEpochHeader} {
		for _, duplicate := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/duplicate=%t", header, duplicate), func(t *testing.T) {
				ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_GetInfo_FullMethodName, &pb.Empty{}, nil)
				if err != nil {
					t.Fatal(err)
				}
				values, _ := metadata.FromOutgoingContext(ctx)
				values = values.Copy()
				if duplicate {
					values[header] = append(values[header], values[header][0])
				} else {
					values.Delete(header)
				}
				if _, err := client.GetInfo(metadata.NewOutgoingContext(ctx, values), &pb.Empty{}); status.Code(err) != codes.Unauthenticated {
					t.Fatalf("invalid header admitted: %v", err)
				}
			})
		}
	}
}

func TestRPCConcurrentReplayAdmitsExactlyOneMutation(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	request := &pb.FileWrite{Path: "/workspace/once", ExpectedRevision: "missing", Content: []byte("once")}
	ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WriteFile_FullMethodName, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	results := make(chan error, 32)
	for range 32 {
		group.Add(1)
		go func() { defer group.Done(); _, err := client.WriteFile(ctx, request); results <- err }()
	}
	group.Wait()
	close(results)
	admitted := 0
	for err := range results {
		if err == nil {
			admitted++
		} else if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("replay result: %v", err)
		}
	}
	if admitted != 1 {
		t.Fatalf("concurrent replay admitted %d mutations", admitted)
	}
}

func TestRPCScopedContentCannotEnterUnboundedHandlers(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	for _, test := range []struct{ name, path string }{
		{"selected directory", "/workspace/docs"},
		{"maximum target", "/workspace/" + strings.Repeat("a", 4096-len("/workspace/"))},
		{"maximum escaped target", "/workspace/" + strings.Repeat("\"", 4096-len("/workspace/"))},
		{"maximum UTF-8 target", "/workspace/" + strings.Repeat("界", 1361) + "aa"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := &pb.Path{Path: test.path}
			ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_ListFiles_FullMethodName, request, func(c *guestauth.Context) {
				c.Actor = guestauth.Actor{Kind: "agent", Subject: "77777777-7777-4777-8777-777777777777", GrantID: "88888888-8888-4888-8888-888888888888"}
				c.Observation = &guestauth.ObservationBudget{MaxBytes: 1024, MaxItems: 2}
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ListFiles(ctx, request)
			if status.Code(err) != codes.PermissionDenied || status.Convert(err).Message() != "scoped content requires a bounded observer RPC" {
				t.Fatalf("valid proof did not reach the scoped-handler gate: %v", err)
			}
		})
	}
}

func TestRPCScopedCanonicalReadRetainsAuthorizationBoundary(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	request := &pb.Path{Path: "/workspace/lab/README.md"}
	ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_ReadFile_FullMethodName, request, func(c *guestauth.Context) {
		c.Actor = guestauth.Actor{Kind: "agent", Subject: "77777777-7777-4777-8777-777777777777", GrantID: "88888888-8888-4888-8888-888888888888"}
		c.Observation = &guestauth.ObservationBudget{MaxBytes: 1024, MaxItems: 2}
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ReadFile(ctx, request)
	if status.Code(err) != codes.PermissionDenied || status.Convert(err).Message() != "scoped content requires a bounded observer RPC" {
		t.Fatalf("canonical proof did not reach the bounded-handler gate: %v", err)
	}
	ctx, err = signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_ReadFile_FullMethodName, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Path = "/lab/README.md"
	if _, err := client.ReadFile(ctx, request); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("changed signed target admitted: %v", err)
	}
}

func TestRPCStreamingOpeningMessageIsSignedAndSingleUse(t *testing.T) {
	api := testAPIServer(t)
	client := unsignedRPCTestClient(t, api)
	request := &pb.FileWatch{Path: "/workspace"}
	ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WatchFiles_FullMethodName, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.WatchFiles(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Header(); err != nil {
		t.Fatal(err)
	}
	replay, err := client.WatchFiles(ctx, request)
	if err == nil {
		_, err = replay.Recv()
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("replayed watch admitted: %v", err)
	}
	first := &pb.TerminalInput{Action: &pb.TerminalInput_Attach{Attach: &pb.TerminalAttach{Id: "signed-terminal"}}}
	ctx, err = signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_AttachTerminal_FullMethodName, first, nil)
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := client.AttachTerminal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := terminal.Send(&pb.TerminalInput{Action: &pb.TerminalInput_Attach{Attach: &pb.TerminalAttach{Id: "other-terminal"}}}); err != nil {
		t.Fatal(err)
	}
	_, err = terminal.Recv()
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unsigned terminal opening admitted: %v", err)
	}
}

func TestGuestRPCStartupRequiresAuthorityBeforeCreatingWorkspace(t *testing.T) {
	root := filepath.Join(t.TempDir(), "uncreated-workspace")
	if server, err := newAPIServer(apiConfig{bootstrapToken: "test", workspaceRoot: root}); err == nil {
		server.close()
		t.Fatal("guest started without signed authorization")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("unauthorized startup created the workspace: %v", err)
	}
}

func TestGuestRootClaimPublicationAndRetirement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claim.json")
	if err := publishGuestClaim(path, fixtureGuestClaim); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := decodeGuestRuntimeClaim(contents)
	if err != nil || claim != fixtureGuestClaim {
		t.Fatalf("published claim = %+v, %v", claim, err)
	}
	invalid := fixtureGuestClaim
	invalid.RuntimeEpoch = ""
	if err := publishGuestClaim(path, invalid); err == nil {
		t.Fatal("published incomplete runtime claim")
	}
	if err := clearGuestClaim(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("retired claim is still readable: %v", err)
	}
}

func TestGuestRPCRejectsNoncanonicalWireEncoding(t *testing.T) {
	codec := guestRPCCodec{}
	canonical, err := codec.Marshal(&pb.Path{Path: "/workspace/signed"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded pb.Path
	if err := codec.Unmarshal(canonical, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := codec.Unmarshal(append([]byte{0x0a, 0x00}, canonical...), &decoded); err == nil {
		t.Fatal("duplicate protobuf field can bypass the exact signed body")
	}
}

func TestGuestRootFilesRejectSymlinksWritesOversizeAndFIFOs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "verification-key")
	key := fixtureGuestKey().Public().(ed25519.PublicKey)
	if err := os.WriteFile(path, key, 0644); err != nil {
		t.Fatal(err)
	}
	contents, err := readGuestRootFile(path, 32)
	if os.Geteuid() == 0 {
		if err != nil || !bytes.Equal(contents, key) {
			t.Fatalf("root-owned key = %x, %v", contents, err)
		}
	} else if err == nil {
		t.Fatal("non-root owned authority accepted")
	}
	link := path + "-link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readGuestRootFile(link, 32); err == nil {
		t.Fatal("authority symlink accepted")
	}
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := readGuestRootFile(path, 32); err == nil {
		t.Fatal("writable authority accepted")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, 33), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readGuestRootFile(path, 32); err == nil {
		t.Fatal("oversized authority accepted")
	}
	fifo := path + "-fifo"
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readGuestRootFile(fifo, 32); err == nil {
		t.Fatal("authority FIFO accepted")
	}
}

func TestRPCRechecksRuntimeBeforeReturningUnaryOrStreamData(t *testing.T) {
	for _, watch := range []bool{false, true} {
		t.Run(fmt.Sprintf("watch=%t", watch), func(t *testing.T) {
			api := testAPIServer(t)
			var calls atomic.Int32
			api.guestAuthorization.claim = func() (guestauth.RuntimeClaim, error) {
				claim := fixtureGuestClaim
				if calls.Add(1) > 1 {
					claim.RuntimeEpoch = "99999999-9999-4999-8999-999999999999"
				}
				return claim, nil
			}
			client := unsignedRPCTestClient(t, api)
			var result error
			if watch {
				request := &pb.FileWatch{Path: "/workspace"}
				ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_WatchFiles_FullMethodName, request, nil)
				if err != nil {
					t.Fatal(err)
				}
				stream, err := client.WatchFiles(ctx, request)
				if err == nil {
					_, err = stream.Recv()
				}
				result = err
			} else {
				ctx, err := signedFixtureRPCContext(rpcTestContext(t), pb.NanoagentService_GetInfo_FullMethodName, &pb.Empty{}, nil)
				if err != nil {
					t.Fatal(err)
				}
				_, result = client.GetInfo(ctx, &pb.Empty{})
			}
			if status.Code(result) != codes.PermissionDenied {
				t.Fatalf("response crossed a runtime change: %v", result)
			}
		})
	}
}
