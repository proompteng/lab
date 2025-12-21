package codex_test

import (
	"bytes"
	"context"
	"errors"
	"log"
	"testing"

	"github.com/segmentio/kafka-go"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/proompteng/lab/services/facteur/internal/codex"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
)

type stubReader struct {
	messages  []kafka.Message
	index     int
	fetchErr  error
	commitErr error
	committed []kafka.Message
	closed    bool
}

func (s *stubReader) FetchMessage(ctx context.Context) (kafka.Message, error) {
	if s.index < len(s.messages) {
		msg := s.messages[s.index]
		s.index++
		return msg, nil
	}
	if s.fetchErr != nil {
		return kafka.Message{}, s.fetchErr
	}
	<-ctx.Done()
	return kafka.Message{}, ctx.Err()
}

func (s *stubReader) CommitMessages(_ context.Context, msgs ...kafka.Message) error {
	if s.commitErr != nil {
		return s.commitErr
	}
	s.committed = append(s.committed, msgs...)
	return nil
}

func (s *stubReader) Close() error {
	s.closed = true
	return nil
}

func TestListenerRun_LogsStructuredMessage(t *testing.T) {
	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 42,
	}
	payload, err := proto.Marshal(task)
	require.NoError(t, err)

	reader := &stubReader{
		messages: []kafka.Message{
			{
				Key:   []byte("issue-42-implementation"),
				Value: payload,
			},
		},
		fetchErr: context.Canceled,
	}

	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	listener := codex.NewListener(reader, logger)
	err = listener.Run(context.Background())
	require.NoError(t, err)

	require.Len(t, reader.committed, 1)
	require.True(t, reader.closed)
	output := buf.String()
	require.Contains(t, output, "codex task key=issue-42-implementation")
	require.Contains(t, output, `"stage":"CODEX_TASK_STAGE_IMPLEMENTATION"`)
	require.Contains(t, output, `"issueNumber":"42"`)
}

func TestListenerRun_LogsReviewStage(t *testing.T) {
	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_REVIEW,
		Repository:  "proompteng/lab",
		IssueNumber: 101,
		ReviewContext: &froussardpb.CodexReviewContext{
			Summary: proto.String("1 unresolved thread"),
			ReviewThreads: []*froussardpb.CodexReviewThread{
				{
					Summary: "Update tests",
					Url:     proto.String("https://example.com/thread"),
				},
			},
		},
	}
	payload, err := proto.Marshal(task)
	require.NoError(t, err)

	reader := &stubReader{
		messages: []kafka.Message{
			{
				Key:   []byte("issue-101-review"),
				Value: payload,
			},
		},
		fetchErr: context.Canceled,
	}

	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	listener := codex.NewListener(reader, logger)
	err = listener.Run(context.Background())
	require.NoError(t, err)

	require.Len(t, reader.committed, 1)
	output := buf.String()
	require.Contains(t, output, `"stage":"CODEX_TASK_STAGE_REVIEW"`)
	require.Contains(t, output, `"issueNumber":"101"`)
	require.Contains(t, output, `"summary":"1 unresolved thread"`)
	require.Contains(t, output, "non-implementation task ignored")
}

func TestListenerRun_IgnoresInvalidMessage(t *testing.T) {
	reader := &stubReader{
		messages: []kafka.Message{
			{Key: []byte("bad"), Value: []byte("not-proto")},
		},
		fetchErr: context.Canceled,
	}
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	listener := codex.NewListener(reader, logger)
	err := listener.Run(context.Background())
	require.NoError(t, err)

	require.Len(t, reader.committed, 1)
	require.Contains(t, buf.String(), "discard invalid payload")
}

func TestListenerRun_BubblesCommitError(t *testing.T) {
	task := &froussardpb.CodexTask{}
	payload, err := proto.Marshal(task)
	require.NoError(t, err)

	reader := &stubReader{
		messages: []kafka.Message{
			{Key: []byte("issue-1"), Value: payload},
		},
		commitErr: errors.New("commit failed"),
	}

	listener := codex.NewListener(reader, log.New(&bytes.Buffer{}, "", 0))
	err = listener.Run(context.Background())
	require.Error(t, err)
	require.Contains(t, err.Error(), "commit message")
}

func TestListenerRun_StopsOnContextError(t *testing.T) {
	reader := &stubReader{
		fetchErr: context.Canceled,
	}

	listener := codex.NewListener(reader, log.New(&bytes.Buffer{}, "", 0))
	err := listener.Run(context.Background())
	require.NoError(t, err)
}
