package argo

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSystemClockNow(t *testing.T) {
	clock := systemClock{}
	now := clock.Now()
	require.WithinDuration(t, time.Now().UTC(), now, time.Second)
}
