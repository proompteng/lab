package main

import (
	"context"
	"errors"
	"io"
	"sync"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type grpcTerminalWriter struct {
	stream      grpc.BidiStreamingServer[pb.TerminalInput, pb.TerminalOutput]
	done        chan struct{}
	once        sync.Once
	mu          sync.Mutex
	closeCode   codes.Code
	closeReason string
}

func (writer *grpcTerminalWriter) Write(ctx context.Context, output *pb.TerminalOutput) error {
	completed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			select {
			case <-completed:
				return
			default:
			}
			_ = writer.Close(codes.ResourceExhausted, "Terminal client is too slow")
		case <-completed:
		}
	}()
	err := writer.stream.Send(output)
	close(completed)
	return err
}
func (writer *grpcTerminalWriter) Close(code codes.Code, reason string) error {
	writer.once.Do(func() {
		writer.mu.Lock()
		writer.closeCode, writer.closeReason = code, reason
		writer.mu.Unlock()
		close(writer.done)
	})
	return nil
}
func (writer *grpcTerminalWriter) CloseNow() error {
	return writer.Close(codes.Unavailable, "Terminal disconnected")
}
func (writer *grpcTerminalWriter) result() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.closeCode == codes.OK {
		return nil
	}
	return status.Error(writer.closeCode, writer.closeReason)
}

func (server *guestRPCServer) AttachTerminal(stream grpc.BidiStreamingServer[pb.TerminalInput, pb.TerminalOutput]) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	attach := first.GetAttach()
	if attach == nil || attach.Columns > 65535 || attach.Rows > 65535 {
		return status.Error(codes.InvalidArgument, "first terminal message must be a valid attachment")
	}
	session, found := server.api.terminals.get(attach.Id)
	if !found {
		return status.Error(codes.NotFound, "terminal session was not found")
	}
	writer := &grpcTerminalWriter{stream: stream, done: make(chan struct{})}
	attached, err := session.attach(writer, attach.ReconnectToken, attach.Since)
	if err != nil {
		return status.Error(codes.FailedPrecondition, err.Error())
	}
	defer session.detach(attached)
	defer attached.close(codes.OK, "Terminal disconnected")
	if attach.Columns > 0 && attach.Rows > 0 {
		session.resize(uint16(attach.Columns), uint16(attach.Rows))
	}

	type received struct {
		input *pb.TerminalInput
		err   error
	}
	inputs := make(chan received, 1)
	receivingDone := make(chan struct{})
	defer close(receivingDone)
	go func() {
		for {
			input, err := stream.Recv()
			select {
			case inputs <- received{input, err}:
			case <-receivingDone:
				return
			case <-stream.Context().Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-stream.Context().Done():
			return status.FromContextError(stream.Context().Err()).Err()
		case <-writer.done:
			return writer.result()
		case received := <-inputs:
			if errors.Is(received.err, io.EOF) {
				return nil
			}
			if received.err != nil {
				return received.err
			}
			switch action := received.input.Action.(type) {
			case *pb.TerminalInput_Input:
				if len(action.Input) > 1<<20 {
					return status.Error(codes.ResourceExhausted, "terminal input exceeds the frame limit")
				}
				if err := session.inputContext(stream.Context(), action.Input); err != nil {
					if stream.Context().Err() != nil {
						return status.FromContextError(stream.Context().Err()).Err()
					}
					return status.Error(codes.Unavailable, "terminal input failed")
				}
			case *pb.TerminalInput_Resize:
				if action.Resize.Columns > 65535 || action.Resize.Rows > 65535 {
					return status.Error(codes.InvalidArgument, "invalid terminal dimensions")
				}
				session.resize(uint16(action.Resize.Columns), uint16(action.Resize.Rows))
			case *pb.TerminalInput_Signal:
				if err := session.signal(action.Signal); err != nil {
					attached.enqueue(&pb.TerminalOutput{Event: &pb.TerminalOutput_Error{Error: err.Error()}})
				}
			case *pb.TerminalInput_Ping:
				attached.enqueue(&pb.TerminalOutput{Event: &pb.TerminalOutput_Pong{Pong: &pb.Empty{}}})
			case *pb.TerminalInput_Terminate:
				server.api.terminals.terminate(session.id)
				return nil
			default:
				return status.Error(codes.InvalidArgument, "invalid terminal command")
			}
		}
	}
}
