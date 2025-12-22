package codex

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// MessageReader represents the subset of kafka.Reader methods used by Listener.
type MessageReader interface {
	FetchMessage(context.Context) (kafka.Message, error)
	CommitMessages(context.Context, ...kafka.Message) error
	Close() error
}

// Logger captures log output; log.Logger satisfies this interface.
type Logger interface {
	Printf(string, ...interface{})
}

// Listener consumes structured Codex tasks and emits human-friendly logs.
type Listener struct {
	reader MessageReader
	logger Logger
}

// NewListener constructs a Listener from the provided reader and logger.
func NewListener(reader MessageReader, logger Logger) *Listener {
	if logger == nil {
		logger = log.Default()
	}
	return &Listener{
		reader: reader,
		logger: logger,
	}
}

// Run streams messages until the context is cancelled or a fatal error occurs.
func (l *Listener) Run(ctx context.Context) error {
	defer func() {
		if err := l.reader.Close(); err != nil {
			l.logger.Printf("codex listener close error: %v", err)
		}
	}()

	marshalOpts := protojson.MarshalOptions{
		EmitUnpopulated: false,
		Indent:          "",
	}

	for {
		msg, err := l.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil
			}
			return fmt.Errorf("fetch message: %w", err)
		}

		var task froussardpb.CodexTask
		if unmarshalErr := proto.Unmarshal(msg.Value, &task); unmarshalErr != nil {
			l.logger.Printf("codex listener: discard invalid payload key=%s err=%v", string(msg.Key), unmarshalErr)
			if commitErr := l.reader.CommitMessages(ctx, msg); commitErr != nil {
				return fmt.Errorf("commit invalid message: %w", commitErr)
			}
			continue
		}

		stage := task.GetStage().String()
		payload, marshalErr := marshalOpts.Marshal(&task)
		if marshalErr != nil {
			l.logger.Printf("codex listener: marshal payload failed key=%s stage=%s err=%v", string(msg.Key), stage, marshalErr)
		} else {
			l.logger.Printf(
				"codex task key=%s stage=%s repo=%s issue=%d payload=%s",
				string(msg.Key),
				stage,
				task.GetRepository(),
				task.GetIssueNumber(),
				string(payload),
			)
		}

		if task.GetStage() != froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION {
			l.logger.Printf(
				"codex listener: non-implementation task ignored key=%s stage=%s repo=%s issue=%d",
				string(msg.Key),
				stage,
				task.GetRepository(),
				task.GetIssueNumber(),
			)
		}

		if commitErr := l.reader.CommitMessages(ctx, msg); commitErr != nil {
			return fmt.Errorf("commit message: %w", commitErr)
		}
	}
}
