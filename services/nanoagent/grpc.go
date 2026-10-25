package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const guestProtocolVersion = 8
const maxGuestRPCBytes = 10 << 20

type guestRPCServer struct {
	pb.UnimplementedNanoagentServiceServer
	api *apiServer
}

func (server *apiServer) newRPCServer() *grpc.Server {
	authenticated := func(ctx context.Context) error {
		values := metadata.ValueFromIncomingContext(ctx, "authorization")
		if len(values) != 1 {
			return status.Error(codes.Unauthenticated, "invalid Nanoagent credentials")
		}
		token, found := strings.CutPrefix(values[0], "Bearer ")
		if !found || subtle.ConstantTimeCompare([]byte(token), []byte(server.bootstrapToken)) != 1 {
			return status.Error(codes.Unauthenticated, "invalid Nanoagent credentials")
		}
		return nil
	}
	rpc := grpc.NewServer(
		grpc.ForceServerCodec(guestRPCCodec{}),
		grpc.MaxRecvMsgSize(maxGuestRPCBytes), grpc.MaxSendMsgSize(maxGuestRPCBytes),
		grpc.UnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (result any, rpcErr error) {
			defer func() { recordGuestRPC(ctx, info.FullMethod, rpcErr) }()
			if err := authenticated(ctx); err != nil {
				return nil, err
			}
			claim, err := server.guestAuthorization.admit(ctx, info.FullMethod, req)
			if err != nil {
				return nil, err
			}
			result, err = handler(ctx, req)
			if changed := server.guestAuthorization.requireClaim(claim); changed != nil {
				return nil, changed
			}
			return result, err
		}),
		grpc.StreamInterceptor(func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (rpcErr error) {
			defer func() { recordGuestRPC(stream.Context(), info.FullMethod, rpcErr) }()
			if err := authenticated(stream.Context()); err != nil {
				return err
			}
			return handler(srv, &authorizedGuestStream{ServerStream: stream, authorization: server.guestAuthorization, method: info.FullMethod})
		}),
	)
	pb.RegisterNanoagentServiceServer(rpc, &guestRPCServer{api: server})
	return rpc
}

func (server *apiServer) rpcHandler(httpHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
			server.rpc.ServeHTTP(w, r)
			return
		}
		httpHandler.ServeHTTP(w, r)
	})
}

func guestHTTPProtocols() *http.Protocols {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetHTTP2(true)
	protocols.SetUnencryptedHTTP2(true)
	return protocols
}

func rpcOperationError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return status.FromContextError(err).Err()
	}
	failure := workspaceFailure(err)
	result, detailErr := status.New(failure.code, failure.message).WithDetails(&pb.OperationFailure{CurrentRevision: failure.currentRevision, ResourceTooLarge: failure.resourceTooLarge})
	if detailErr != nil {
		return status.Error(codes.Internal, "encode operation failure")
	}
	return result.Err()
}

func protoFile(entry fileEntry) *pb.FileEntry {
	return &pb.FileEntry{Name: entry.Name, Path: entry.Path, Directory: entry.Directory, Size: entry.Size, ModifiedAt: entry.ModifiedAt}
}
func protoFiles(entries []fileEntry) []*pb.FileEntry {
	result := make([]*pb.FileEntry, len(entries))
	for i, entry := range entries {
		result[i] = protoFile(entry)
	}
	return result
}
func protoTerminal(session terminalSessionView) *pb.TerminalSession {
	return &pb.TerminalSession{Id: session.ID, CreationId: session.CreationID, Cwd: session.Cwd, CreatedAt: session.CreatedAt.UTC().Format(time.RFC3339Nano), LastActivityAt: session.LastActivityAt.UTC().Format(time.RFC3339Nano), Attached: session.Attached}
}

func (server *guestRPCServer) GetInfo(context.Context, *pb.Empty) (*pb.GuestInfo, error) {
	info := &pb.GuestInfo{MicrovmId: server.api.evidence.MicroVMID, ProtocolVersion: guestProtocolVersion}
	if server.api.codex != nil {
		info.CodexActivity = server.api.codex.activitySnapshot()
	}
	return info, nil
}
func (server *guestRPCServer) OpenBrowser(ctx context.Context, _ *pb.Empty) (*pb.Browser, error) {
	if server.api.browser == nil {
		return nil, status.Error(codes.Unavailable, "Chromium is unavailable in this guest. An operator must update the prepared slot's guest image.")
	}
	if err := server.api.browser.ensure(ctx); err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	return &pb.Browser{Port: browserPort}, nil
}
func (server *guestRPCServer) OpenEditor(ctx context.Context, _ *pb.Empty) (*pb.Editor, error) {
	if server.api.editor == nil {
		return nil, status.Error(codes.Unavailable, "VS Code is not installed in this guest. Sleep and resume the agent to install the current guest image.")
	}
	if err := server.api.editor.ensure(ctx); err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	return &pb.Editor{Port: editorPort}, nil
}
func (server *guestRPCServer) StatFile(_ context.Context, req *pb.Path) (*pb.FileEntry, error) {
	relative, err := server.api.workspace.relative(req.Path)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	result, err := server.api.fileEntryRelative(relative)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return protoFile(result), nil
}
func (server *guestRPCServer) ListFiles(_ context.Context, req *pb.Path) (*pb.FileList, error) {
	result, err := server.api.listFiles(req.Path)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return &pb.FileList{Path: result.Path, Entries: protoFiles(result.Entries)}, nil
}
func (server *guestRPCServer) ReadFile(_ context.Context, req *pb.Path) (*pb.FileContent, error) {
	result, err := server.api.readFileSnapshot(req.Path)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return &pb.FileContent{Content: result.content, ContentType: result.contentType, Revision: result.revision}, nil
}
func (server *guestRPCServer) WriteFile(_ context.Context, req *pb.FileWrite) (*pb.FileWriteResult, error) {
	result, err := server.api.writeFile(fileWriteInput{Path: req.Path, Content: req.Content, ExpectedRevision: req.ExpectedRevision})
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return &pb.FileWriteResult{Path: result.Path, Size: result.Size, Revision: result.Revision}, nil
}
func (server *guestRPCServer) CreateDirectory(_ context.Context, req *pb.Path) (*pb.FileEntry, error) {
	result, err := server.api.createDirectory(pathRequest{Path: req.Path})
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return protoFile(result), nil
}
func (server *guestRPCServer) MoveFile(_ context.Context, req *pb.FileMove) (*pb.FileEntry, error) {
	result, err := server.api.moveFile(moveFileRequest{SourcePath: req.SourcePath, DestinationPath: req.DestinationPath})
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return protoFile(result), nil
}
func (server *guestRPCServer) DeleteFile(_ context.Context, req *pb.FileDelete) (*pb.Empty, error) {
	_, err := server.api.deleteFile(deleteFileRequest{Path: req.Path, Recursive: req.Recursive})
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return &pb.Empty{}, nil
}
func (server *guestRPCServer) SearchFiles(ctx context.Context, req *pb.FileSearch) (*pb.FileSearchResult, error) {
	query := strings.ToLower(strings.TrimSpace(req.Query))
	if query == "" || len(query) > 256 || req.Limit < 1 || req.Limit > 200 {
		return nil, status.Error(codes.InvalidArgument, "invalid file search query or limit")
	}
	root, err := server.api.workspace.resolveExisting(req.Path)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	result, err := server.api.searchFiles(ctx, root, query, int(req.Limit), maxSearchVisitedEntries)
	if err != nil {
		return nil, rpcOperationError(err)
	}
	return &pb.FileSearchResult{Entries: protoFiles(result.Entries), Truncated: result.Truncated}, nil
}
func (server *guestRPCServer) WatchFiles(req *pb.FileWatch, stream grpc.ServerStreamingServer[pb.FileEvent]) error {
	target, err := server.api.workspace.resolveExisting(req.Path)
	if err != nil {
		return rpcOperationError(err)
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return status.Error(codes.InvalidArgument, "watch path must be a directory")
	}
	var id uint64
	var events <-chan fileEvent
	if req.After == nil {
		id, events, err = server.api.fileWatcher.subscribeCurrent(server.api.workspace.displayPath(target), target)
	} else {
		id, events, err = server.api.fileWatcher.subscribe(*req.After, server.api.workspace.displayPath(target), target)
	}
	if err != nil {
		return status.Error(codes.ResourceExhausted, err.Error())
	}
	defer server.api.fileWatcher.unsubscribe(id)
	if err := stream.SendHeader(metadata.MD{}); err != nil {
		return err
	}
	for {
		select {
		case <-stream.Context().Done():
			return status.FromContextError(stream.Context().Err()).Err()
		case event, open := <-events:
			if !open {
				return status.Error(codes.ResourceExhausted, "file event subscription ended; reconnect from the last cursor")
			}
			result := &pb.FileEvent{Sequence: event.Sequence, Kind: event.Kind, Path: event.Path, PreviousPath: event.PreviousPath}
			if event.Entry != nil {
				result.Entry = protoFile(*event.Entry)
			}
			if err := stream.Send(result); err != nil {
				return err
			}
		}
	}
}
func (server *guestRPCServer) CreateTerminal(ctx context.Context, req *pb.TerminalCreate) (*pb.TerminalCreated, error) {
	if !validTerminalCreationID(req.CreationId) || req.Columns > 65535 || req.Rows > 65535 {
		return nil, status.Error(codes.InvalidArgument, "invalid terminal creation identity or dimensions")
	}
	session, created, err := server.api.terminals.create(req.CreationId, req.Cwd, uint16(req.Columns), uint16(req.Rows))
	if err != nil {
		if strings.Contains(err.Error(), "four terminal") {
			return nil, status.Error(codes.ResourceExhausted, err.Error())
		}
		return nil, rpcOperationError(err)
	}
	if err := ctx.Err(); err != nil {
		return nil, status.FromContextError(err).Err()
	}
	return &pb.TerminalCreated{Session: protoTerminal(session), Created: created}, nil
}
func (server *guestRPCServer) ListTerminals(context.Context, *pb.Empty) (*pb.TerminalList, error) {
	result := &pb.TerminalList{}
	for _, session := range server.api.terminals.list() {
		result.Sessions = append(result.Sessions, protoTerminal(session))
	}
	return result, nil
}
func (server *guestRPCServer) TerminateTerminal(_ context.Context, req *pb.TerminalID) (*pb.Empty, error) {
	if !server.api.terminals.terminate(req.Id) {
		return nil, status.Error(codes.NotFound, "terminal session was not found")
	}
	return &pb.Empty{}, nil
}
func (server *guestRPCServer) CodexCall(ctx context.Context, req *pb.CodexRequest) (*pb.CodexResult, error) {
	if server.api.codex == nil {
		return nil, status.Error(codes.Unavailable, "Codex app-server is disabled")
	}
	if len(req.ParamsJson) > maxJSONBodyBytes || !json.Valid(req.ParamsJson) || !allowedCodexMethod(req.Method) {
		return nil, status.Error(codes.InvalidArgument, "invalid Codex request")
	}
	result, err := server.api.codex.call(ctx, req.Method, req.ParamsJson)
	if err != nil {
		if errors.Is(err, errCodexOperationRejected) {
			failure, detailErr := status.New(codes.InvalidArgument, errCodexOperationRejected.Error()).WithDetails(&pb.OperationFailure{CodexOperationRejected: true})
			if detailErr != nil {
				return nil, status.Error(codes.Internal, "encode Codex rejection")
			}
			return nil, failure.Err()
		}
		if errors.Is(err, errCodexOperationConflict) {
			return nil, status.Error(codes.AlreadyExists, errCodexOperationConflict.Error())
		}
		if errors.Is(err, errCodexThreadActive) {
			return nil, status.Error(codes.FailedPrecondition, errCodexThreadActive.Error())
		}
		if errors.Is(err, errCodexOperationUnknown) {
			return nil, status.Error(codes.FailedPrecondition, errCodexOperationUnknown.Error())
		}
		if isMissingCodexConversation(req.Method, req.ParamsJson, err) {
			return nil, status.Error(codes.NotFound, codexConversationNotFoundMessage)
		}
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	return &pb.CodexResult{ResultJson: result.result, EventSequence: result.eventSequence}, nil
}
func (server *guestRPCServer) CodexLogin(context.Context, *pb.Empty) (*pb.CodexLoginState, error) {
	if server.api.codex == nil {
		return nil, status.Error(codes.Unavailable, "Codex app-server is disabled")
	}
	result := server.api.codex.loginSnapshot()
	return &pb.CodexLoginState{Active: result.Active, ResultJson: result.Result, StartedAt: result.StartedAt}, nil
}
func (server *guestRPCServer) WatchCodexEvents(req *pb.CodexWatch, stream grpc.ServerStreamingServer[pb.CodexEvent]) error {
	if server.api.codex == nil {
		return status.Error(codes.Unavailable, "Codex app-server is disabled")
	}
	id, events, err := server.api.codex.subscribe(req.After)
	if err != nil {
		return status.Error(codes.ResourceExhausted, err.Error())
	}
	defer server.api.codex.unsubscribe(id)
	if err := stream.SendHeader(metadata.MD{}); err != nil {
		return err
	}
	for {
		select {
		case <-stream.Context().Done():
			return status.FromContextError(stream.Context().Err()).Err()
		case event, open := <-events:
			if !open {
				return status.Error(codes.ResourceExhausted, "Codex event subscription ended; reconnect from the last cursor")
			}
			if err := stream.Send(&pb.CodexEvent{Sequence: event.Sequence, Method: event.Method, ApprovalId: event.ApprovalID, RawJson: event.Raw}); err != nil {
				return err
			}
		}
	}
}
