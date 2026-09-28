package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/proompteng/lab/services/facteur/migrations"
)

// ErrMissingDSN indicates that the Postgres DSN required for migrations was not supplied.
var ErrMissingDSN = errors.New("postgres DSN is required")

type gooseRunner interface {
	UpTo(ctx context.Context, version int64) ([]*goose.MigrationResult, error)
}

type providerFactory func(db *sql.DB, logger *slog.Logger) (gooseRunner, error)

type dbOpener func(name, dsn string) (*sql.DB, error)

// Runner applies embedded SQL migrations using goose.
type Runner struct {
	opener   dbOpener
	factory  providerFactory
	loggerFn func() *slog.Logger
}

// NewRunner constructs a Runner that uses the pgx driver and the embedded migrations FS.
func NewRunner() *Runner {
	return &Runner{
		opener: sql.Open,
		factory: func(db *sql.DB, logger *slog.Logger) (gooseRunner, error) {
			opts := []goose.ProviderOption{}
			if logger != nil {
				opts = append(opts, goose.WithSlog(logger))
			}
			return goose.NewProvider(goose.DialectPostgres, db, migrations.Files, opts...)
		},
		loggerFn: slog.Default,
	}
}

// Up ensures that all migrations up to goose.MaxVersion have been applied.
func (r *Runner) Up(ctx context.Context, dsn string, logger *slog.Logger) ([]*goose.MigrationResult, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, ErrMissingDSN
	}

	if logger == nil {
		logger = r.loggerFn()
	}

	db, err := r.opener("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres connection: %w", err)
	}
	defer db.Close()

	provider, err := r.factory(db, logger)
	if err != nil {
		return nil, fmt.Errorf("init goose provider: %w", err)
	}

	logger.InfoContext(ctx, "applying facteur migrations")
	results, err := provider.UpTo(ctx, goose.MaxVersion)
	if err != nil {
		return nil, fmt.Errorf("apply migrations: %w", err)
	}
	logger.InfoContext(ctx, "facteur migrations applied", "target_version", goose.MaxVersion)

	return results, nil
}

// Up applies migrations using the default runner.
func Up(ctx context.Context, dsn string, logger *slog.Logger) ([]*goose.MigrationResult, error) {
	return NewRunner().Up(ctx, dsn, logger)
}
