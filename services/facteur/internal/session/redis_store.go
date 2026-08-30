package session

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisStore persists session data using Redis key/value pairs.
type RedisStore struct {
	client redis.UniversalClient
	prefix string
}

// Option customises the RedisStore instance.
type Option func(*RedisStore)

// WithPrefix overrides the key prefix (defaults to "facteur").
func WithPrefix(prefix string) Option {
	return func(store *RedisStore) {
		store.prefix = strings.TrimSuffix(prefix, ":")
	}
}

// NewRedisStore constructs a Redis-backed Store from an existing client.
func NewRedisStore(client redis.UniversalClient, opts ...Option) (*RedisStore, error) {
	if client == nil {
		return nil, fmt.Errorf("session: redis client is required")
	}

	store := &RedisStore{client: client, prefix: "facteur"}
	for _, opt := range opts {
		opt(store)
	}

	return store, nil
}

// NewRedisStoreFromURL builds a Redis client from a connection URL.
func NewRedisStoreFromURL(url string, opts ...Option) (*RedisStore, error) {
	cfg, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("session: parse redis url: %w", err)
	}

	client := redis.NewClient(cfg)

	store, err := NewRedisStore(client, opts...)
	if err != nil {
		return nil, err
	}

	return store, nil
}

// Set writes a value with the supplied TTL.
func (s *RedisStore) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := s.client.Set(ctx, s.key(key), value, ttl).Err(); err != nil {
		return fmt.Errorf("session: set key: %w", err)
	}
	return nil
}

// Get reads a value and returns ErrNotFound if it does not exist.
func (s *RedisStore) Get(ctx context.Context, key string) ([]byte, error) {
	bytes, err := s.client.Get(ctx, s.key(key)).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("session: get key: %w", err)
	}
	return bytes, nil
}

// Delete removes a value and treats missing keys as success.
func (s *RedisStore) Delete(ctx context.Context, key string) error {
	if err := s.client.Del(ctx, s.key(key)).Err(); err != nil {
		return fmt.Errorf("session: delete key: %w", err)
	}
	return nil
}

func (s *RedisStore) key(key string) string {
	return fmt.Sprintf("%s:%s", s.prefix, key)
}
