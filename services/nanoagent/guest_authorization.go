package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/proompteng/lab/services/nanoagent/internal/guestauth"
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const guestVerificationKeyPath = "/run/tengri/guest-verify.pub"
const guestRecoveryGenerationPath = "/run/tengri/recovery-generation"
const guestRuntimeClaimPath = "/run/tengri/claim.json"
const guestClaimUIDHeader = "x-tengri-microvm-uid"
const guestClaimEpochHeader = "x-tengri-claim-epoch"
const guestRuntimeEpochHeader = "x-tengri-runtime-epoch"

func prepareGuestAuthority(directory string, key []byte, recoveryGeneration uint64) error {
	if _, err := guestauth.NewVerifier(key); err != nil {
		return err
	}
	if recoveryGeneration == 0 || recoveryGeneration > 1<<63-1 {
		return errors.New("positive guest recovery generation required")
	}
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != 0 || !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		return errors.New("guest authority directory must belong to root and deny group or other writes")
	}
	if err := os.Chmod(directory, 0755); err != nil {
		return err
	}
	if err := clearGuestClaim(filepath.Join(directory, "claim.json")); err != nil {
		return err
	}
	if err := atomicGuestAuthorityFile(filepath.Join(directory, "guest-verify.pub"), key); err != nil {
		return err
	}
	return atomicGuestAuthorityFile(filepath.Join(directory, "recovery-generation"), []byte(strconv.FormatUint(recoveryGeneration, 10)))
}

func clearGuestClaim(path string) error {
	if path == "" {
		return errors.New("guest runtime claim path is required")
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func publishGuestClaim(path string, claim guestauth.RuntimeClaim) error {
	if err := claim.Validate(); err != nil {
		return err
	}
	contents, err := json.Marshal(claim)
	if err != nil {
		return err
	}
	return atomicGuestAuthorityFile(path, contents)
}

func atomicGuestAuthorityFile(path string, contents []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".guest-authority-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0644); err != nil {
		return err
	}
	if _, err := file.Write(contents); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

type guestRPCAdmission struct {
	admission          *guestauth.Admission
	recoveryGeneration uint64
	claim              func() (guestauth.RuntimeClaim, error)
}

func readGuestRootFile(path string, limit int64) ([]byte, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > limit {
		return nil, errors.New("guest authority requires a bounded root-owned regular file without group or other write access")
	}
	contents, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(contents)) > limit {
		return nil, errors.New("read bounded guest authority file")
	}
	return contents, nil
}

func loadGuestRPCAdmission() (*guestRPCAdmission, error) {
	key, err := readGuestRootFile(guestVerificationKeyPath, 32)
	if err != nil {
		return nil, fmt.Errorf("load guest verification key: %w", err)
	}
	generationFile, err := readGuestRootFile(guestRecoveryGenerationPath, 20)
	if err != nil {
		return nil, fmt.Errorf("load guest recovery generation: %w", err)
	}
	generation, err := decodeGuestRecoveryGeneration(generationFile)
	if err != nil {
		return nil, err
	}
	admission, err := guestauth.NewAdmission(key, 10000)
	if err != nil {
		return nil, err
	}
	return &guestRPCAdmission{admission: admission, recoveryGeneration: generation, claim: func() (guestauth.RuntimeClaim, error) {
		contents, err := readGuestRootFile(guestRuntimeClaimPath, 1024)
		if err != nil {
			return guestauth.RuntimeClaim{}, err
		}
		return decodeGuestRuntimeClaim(contents)
	}}, nil
}

func decodeGuestRecoveryGeneration(contents []byte) (uint64, error) {
	value := strings.TrimSuffix(string(contents), "\n")
	generation, err := strconv.ParseUint(value, 10, 63)
	if err != nil || generation == 0 || strconv.FormatUint(generation, 10) != value {
		return 0, errors.New("canonical positive guest recovery generation required")
	}
	return generation, nil
}

func decodeGuestRuntimeClaim(contents []byte) (guestauth.RuntimeClaim, error) {
	var claim guestauth.RuntimeClaim
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claim); err != nil {
		return claim, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return claim, errors.New("trailing guest runtime claim")
	}
	return claim, claim.Validate()
}

func guestRPCTarget(method string, message proto.Message) (string, error) {
	switch method {
	case pb.NanoagentService_GetInfo_FullMethodName, pb.NanoagentService_OpenEditor_FullMethodName,
		pb.NanoagentService_OpenBrowser_FullMethodName, pb.NanoagentService_ListTerminals_FullMethodName,
		pb.NanoagentService_CreateTerminal_FullMethodName, pb.NanoagentService_CodexCall_FullMethodName,
		pb.NanoagentService_CodexLogin_FullMethodName,
		pb.NanoagentService_WatchCodexEvents_FullMethodName:
		return "", nil
	case pb.NanoagentService_StatFile_FullMethodName, pb.NanoagentService_ListFiles_FullMethodName, pb.NanoagentService_ReadFile_FullMethodName,
		pb.NanoagentService_CreateDirectory_FullMethodName:
		if request, ok := message.(*pb.Path); ok {
			return request.Path, nil
		}
	case pb.NanoagentService_WriteFile_FullMethodName:
		if request, ok := message.(*pb.FileWrite); ok {
			return request.Path, nil
		}
	case pb.NanoagentService_MoveFile_FullMethodName:
		if request, ok := message.(*pb.FileMove); ok {
			return request.SourcePath, nil
		}
	case pb.NanoagentService_DeleteFile_FullMethodName:
		if request, ok := message.(*pb.FileDelete); ok {
			return request.Path, nil
		}
	case pb.NanoagentService_SearchFiles_FullMethodName:
		if request, ok := message.(*pb.FileSearch); ok {
			return request.Path, nil
		}
	case pb.NanoagentService_WatchFiles_FullMethodName:
		if request, ok := message.(*pb.FileWatch); ok {
			return request.Path, nil
		}
	case pb.NanoagentService_TerminateTerminal_FullMethodName:
		if request, ok := message.(*pb.TerminalID); ok {
			return request.Id, nil
		}
	case pb.NanoagentService_AttachTerminal_FullMethodName:
		if request, ok := message.(*pb.TerminalInput); ok && request.GetAttach() != nil {
			return request.GetAttach().Id, nil
		}
	}
	return "", errors.New("guest RPC does not have its required request type")
}

func (authorization *guestRPCAdmission) admit(ctx context.Context, method string, value any) (guestauth.RuntimeClaim, error) {
	deny := status.Error(codes.Unauthenticated, "invalid signed guest authorization")
	proof, err := guestauth.ProofFromValues(metadata.ValueFromIncomingContext(ctx, guestauth.ContextHeader), metadata.ValueFromIncomingContext(ctx, guestauth.SignatureHeader))
	if err != nil {
		return guestauth.RuntimeClaim{}, deny
	}
	claim, err := authorization.claim()
	if err != nil {
		return claim, status.Error(codes.Unavailable, "guest runtime is not bound")
	}
	for header, expected := range map[string]string{guestClaimUIDHeader: claim.WorkspaceUID, guestClaimEpochHeader: strconv.FormatUint(claim.SlotEpoch, 10), guestRuntimeEpochHeader: claim.RuntimeEpoch} {
		values := metadata.ValueFromIncomingContext(ctx, header)
		if len(values) != 1 || values[0] != expected {
			return claim, deny
		}
	}
	message, ok := value.(proto.Message)
	if !ok {
		return claim, deny
	}
	action, err := guestauth.RPCAction(method)
	if err != nil {
		return claim, deny
	}
	target, err := guestRPCTarget(method, message)
	if err != nil {
		return claim, deny
	}
	body, err := proto.MarshalOptions{Deterministic: true}.Marshal(message)
	if err != nil {
		return claim, deny
	}
	verified, err := authorization.admission.AdmitGuest(proof, claim, guestauth.RequestBinding{RecoveryGeneration: authorization.recoveryGeneration, Action: action, Method: method, Target: target, Body: body}, uint64(time.Now().UnixMilli()))
	if err != nil {
		return claim, deny
	}
	if verified.Observation != nil && action != guestauth.WorkspaceMetadataRead {
		return claim, status.Error(codes.PermissionDenied, "scoped content requires a bounded observer RPC")
	}
	return claim, nil
}

func (authorization *guestRPCAdmission) requireClaim(expected guestauth.RuntimeClaim) error {
	current, err := authorization.claim()
	if err != nil || current != expected {
		return status.Error(codes.PermissionDenied, "guest runtime changed")
	}
	return nil
}

// Requiring canonical protobuf bytes makes the verified body hash cover the
// actual incoming message, rather than a re-encoded equivalent.
type guestRPCCodec struct{}

func (guestRPCCodec) Name() string { return "proto" }
func (guestRPCCodec) Marshal(value any) ([]byte, error) {
	message, ok := value.(proto.Message)
	if !ok {
		return nil, errors.New("guest RPC requires protobuf")
	}
	return proto.MarshalOptions{Deterministic: true}.Marshal(message)
}
func (codec guestRPCCodec) Unmarshal(contents []byte, value any) error {
	message, ok := value.(proto.Message)
	if !ok {
		return errors.New("guest RPC requires protobuf")
	}
	if err := proto.Unmarshal(contents, message); err != nil {
		return err
	}
	canonical, err := codec.Marshal(message)
	if err != nil || !bytes.Equal(contents, canonical) {
		return errors.New("guest RPC requires canonical protobuf bytes")
	}
	return nil
}

type authorizedGuestStream struct {
	grpc.ServerStream
	authorization *guestRPCAdmission
	method        string
	mu            sync.Mutex
	claim         *guestauth.RuntimeClaim
}

func (stream *authorizedGuestStream) RecvMsg(value any) error {
	if err := stream.ServerStream.RecvMsg(value); err != nil {
		return err
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.claim != nil {
		return stream.authorization.requireClaim(*stream.claim)
	}
	claim, err := stream.authorization.admit(stream.Context(), stream.method, value)
	if err != nil {
		return err
	}
	stream.claim = &claim
	return nil
}

func (stream *authorizedGuestStream) requireClaim() error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.claim == nil {
		return status.Error(codes.Unauthenticated, "guest stream has no authorized opening message")
	}
	return stream.authorization.requireClaim(*stream.claim)
}
func (stream *authorizedGuestStream) SendHeader(headers metadata.MD) error {
	if err := stream.requireClaim(); err != nil {
		return err
	}
	return stream.ServerStream.SendHeader(headers)
}
func (stream *authorizedGuestStream) SendMsg(value any) error {
	if err := stream.requireClaim(); err != nil {
		return err
	}
	return stream.ServerStream.SendMsg(value)
}
