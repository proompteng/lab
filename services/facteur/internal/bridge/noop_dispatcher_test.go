package bridge

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNoopDispatcher(t *testing.T) {
	dispatcher := NoopDispatcher{}
	result, err := dispatcher.Dispatch(context.Background(), DispatchRequest{CorrelationID: "corr", TraceID: "trace"})
	require.NoError(t, err)
	require.Equal(t, "dispatcher disabled", result.Message)
	require.Equal(t, "corr", result.CorrelationID)
	require.Equal(t, "trace", result.TraceID)

	status, err := dispatcher.Status(context.Background())
	require.NoError(t, err)
	require.False(t, status.Ready)
	require.Equal(t, "dispatcher disabled", status.Message)
}
