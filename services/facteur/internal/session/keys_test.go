package session_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/session"
)

func TestDispatchKey(t *testing.T) {
	require.Equal(t, "dispatch:user-123", session.DispatchKey("user-123"))
}
