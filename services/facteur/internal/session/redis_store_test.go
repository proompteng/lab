package session_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/session"
)

func TestRedisStoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	store, err := session.NewRedisStore(client, session.WithPrefix("test"))
	require.NoError(t, err)

	require.NoError(t, store.Set(ctx, "token", []byte("value"), time.Minute))

	got, err := store.Get(ctx, "token")
	require.NoError(t, err)
	require.Equal(t, []byte("value"), got)

	require.NoError(t, store.Delete(ctx, "token"))
	_, err = store.Get(ctx, "token")
	require.ErrorIs(t, err, session.ErrNotFound)
}

func TestRedisStoreTTL(t *testing.T) {
	ctx := context.Background()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	store, err := session.NewRedisStore(client)
	require.NoError(t, err)

	require.NoError(t, store.Set(ctx, "ephemeral", []byte("1"), time.Second))
	mr.FastForward(time.Second * 2)

	_, err = store.Get(ctx, "ephemeral")
	require.ErrorIs(t, err, session.ErrNotFound)
}

func TestRedisStoreFromURL(t *testing.T) {
	mr := miniredis.RunT(t)
	url := "redis://" + mr.Addr()

	store, err := session.NewRedisStoreFromURL(url)
	require.NoError(t, err)

	require.NoError(t, store.Set(context.Background(), "key", []byte("val"), time.Minute))
}

func TestWithPrefixTrimsColon(t *testing.T) {
	ctx := context.Background()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	store, err := session.NewRedisStore(client, session.WithPrefix("custom:"))
	require.NoError(t, err)

	require.NoError(t, store.Set(ctx, "prefixed", []byte("ok"), time.Minute))

	keys := mr.DB(0).Keys()
	require.Contains(t, keys, "custom:prefixed")
}
