package session

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound indicates there was no value for the provided key.
var ErrNotFound = errors.New("session: not found")

// Store persists ephemeral Discord interaction data.
type Store interface {
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
}
