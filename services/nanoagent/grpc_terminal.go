package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/coder/websocket"
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Reuses the session's bounded output queue, replay and reconnect ownership for
// both transports. Only the transport writer translates the browser framing.
type grpcTerminalWriter struct {
	stream      grpc.BidiStreamingServer[pb.TerminalInput, pb.TerminalOutput]
	done        chan struct{}
	once        sync.Once
	mu          sync.Mutex
	closeCode   websocket.StatusCode
	closeReason string
}

func (writer *grpcTerminalWriter) Write(ctx context.Context, kind websocket.MessageType, payload []byte) error {
	output, err := protoTerminalOutput(kind, payload)
	if err != nil {
		return err
	}
	completed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			select {
			case <-completed:
				return
			default:
			}
			_ = writer.Close(websocket.StatusPolicyViolation, "Terminal client is too slow")
		case <-completed:
		}
	}()
	err = writer.stream.Send(output)
	close(completed)
	return err
}
func (writer *grpcTerminalWriter) Close(code websocket.StatusCode, reason string) error {
	writer.once.Do(func() {
		writer.mu.Lock()
		writer.closeCode, writer.closeReason = code, reason
		writer.mu.Unlock()
		close(writer.done)
	})
	return nil
}
func (writer *grpcTerminalWriter) CloseNow() error {
	return writer.Close(websocket.StatusAbnormalClosure, "Terminal disconnected")
}
func (writer *grpcTerminalWriter) result() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.closeCode == websocket.StatusNormalClosure {
		return nil
	}
	return status.Error(codes.ResourceExhausted, writer.closeReason)
}

func protoTerminalOutput(kind websocket.MessageType, payload []byte) (*pb.TerminalOutput, error) {
	if kind == websocket.MessageBinary {
		if len(payload) < 5 || payload[0] != outputFrameType {
			return nil, errors.New("invalid terminal output frame")
		}
		return &pb.TerminalOutput{Event: &pb.TerminalOutput_Output{Output: &pb.TerminalData{Sequence: binary.BigEndian.Uint32(payload[1:5]), Data: payload[5:]}}}, nil
	}
	var control struct {
		Type        string `json:"type"`
		SessionID   string `json:"sessionId"`
		Token       string `json:"token"`
		BufferStart uint32 `json:"bufferStart"`
		BufferEnd   uint32 `json:"bufferEnd"`
		Reason      string `json:"reason"`
		ExitCode    int32  `json:"exitCode"`
		Message     string `json:"message"`
	}
	if err := json.Unmarshal(payload, &control); err != nil {
		return nil, err
	}
	output := &pb.TerminalOutput{}
	switch control.Type {
	case "ready":
		output.Event = &pb.TerminalOutput_Ready{Ready: &pb.TerminalReady{SessionId: control.SessionID, Token: control.Token, BufferStart: control.BufferStart, BufferEnd: control.BufferEnd}}
	case "reset":
		output.Event = &pb.TerminalOutput_Reset_{Reset_: &pb.TerminalReset{Reason: control.Reason, BufferStart: control.BufferStart, BufferEnd: control.BufferEnd}}
	case "exit":
		output.Event = &pb.TerminalOutput_ExitCode{ExitCode: control.ExitCode}
	case "error":
		output.Event = &pb.TerminalOutput_Error{Error: control.Message}
	case "pong":
		output.Event = &pb.TerminalOutput_Pong{Pong: &pb.Empty{}}
	default:
		return nil, errors.New("invalid terminal control frame")
	}
	return output, nil
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
	defer attached.close(websocket.StatusNormalClosure, "Terminal disconnected")
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
					payload, _ := json.Marshal(map[string]string{"type": "error", "message": err.Error()})
					attached.enqueue(terminalMessage{messageType: websocket.MessageText, payload: payload})
				}
			case *pb.TerminalInput_Ping:
				attached.enqueue(terminalMessage{messageType: websocket.MessageText, payload: []byte(`{"type":"pong"}`)})
			case *pb.TerminalInput_Terminate:
				server.api.terminals.terminate(session.id)
				return nil
			default:
				return status.Error(codes.InvalidArgument, "invalid terminal command")
			}
		}
	}
}
