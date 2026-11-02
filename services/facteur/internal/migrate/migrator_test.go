package migrate

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/pressly/goose/v3"
	"github.com/stretchr/testify/require"
)

type stubProvider struct {
	err     error
	version int64
	called  bool
}

func (s *stubProvider) UpTo(_ context.Context, version int64) ([]*goose.MigrationResult, error) {
	s.called = true
	s.version = version
	if s.err != nil {
		return nil, s.err
	}
	return []*goose.MigrationResult{{
		Source: &goose.Source{Version: version, Path: "000001_init_codex_kb.sql"},
	}}, nil
}

func TestRunnerUpMissingDSN(t *testing.T) {
	r := NewRunner()
	_, err := r.Up(context.Background(), "\t", nil)
	require.ErrorIs(t, err, ErrMissingDSN)
}

func TestRunnerUpSuccess(t *testing.T) {
	db, _, err := sqlmock.New()
	require.NoError(t, err)

	provider := &stubProvider{}
	r := &Runner{
		opener: func(_, _ string) (*sql.DB, error) {
			return db, nil
		},
		factory: func(_ *sql.DB, _ *slog.Logger) (gooseRunner, error) {
			return provider, nil
		},
		loggerFn: func() *slog.Logger {
			return slog.New(slog.NewTextHandler(io.Discard, nil))
		},
	}

	results, err := r.Up(context.Background(), "postgres://example", nil)
	require.NoError(t, err)
	require.True(t, provider.called)
	require.Equal(t, goose.MaxVersion, provider.version)
	require.Len(t, results, 1)
	require.NotNil(t, results[0].Source)
	require.Equal(t, goose.MaxVersion, results[0].Source.Version)
}

func TestRunnerUpProviderError(t *testing.T) {
	db, _, err := sqlmock.New()
	require.NoError(t, err)

	provider := &stubProvider{err: errors.New("boom")}
	r := &Runner{
		opener: func(_, _ string) (*sql.DB, error) {
			return db, nil
		},
		factory: func(_ *sql.DB, _ *slog.Logger) (gooseRunner, error) {
			return provider, nil
		},
		loggerFn: func() *slog.Logger {
			return slog.New(slog.NewTextHandler(io.Discard, nil))
		},
	}

	_, err = r.Up(context.Background(), "postgres://example", nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "apply migrations")
}

func TestRunnerUpFactoryError(t *testing.T) {
	db, _, err := sqlmock.New()
	require.NoError(t, err)

	r := &Runner{
		opener: func(_, _ string) (*sql.DB, error) {
			return db, nil
		},
		factory: func(_ *sql.DB, _ *slog.Logger) (gooseRunner, error) {
			return nil, errors.New("factory failure")
		},
		loggerFn: func() *slog.Logger {
			return slog.New(slog.NewTextHandler(io.Discard, nil))
		},
	}

	_, err = r.Up(context.Background(), "postgres://example", nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "init goose provider")
}
