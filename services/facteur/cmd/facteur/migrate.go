package facteur

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/pressly/goose/v3"
	"github.com/spf13/cobra"

	"github.com/proompteng/lab/services/facteur/internal/config"
	"github.com/proompteng/lab/services/facteur/internal/migrate"
)

const missingDSNMessage = "postgres DSN is required; set FACTEUR_POSTGRES_DSN or configure postgres.dsn"

// NewMigrateCommand scaffolds the "migrate" CLI command.
func NewMigrateCommand() *cobra.Command {
	var configPath string

	cmd := &cobra.Command{
		Use:   "migrate",
		Short: "Apply Facteur database migrations and exit",
		RunE: func(cmd *cobra.Command, _ []string) error {
			path := configPath
			if path == "" {
				path = os.Getenv("FACTEUR_CONFIG_FILE")
			}

			cfg, err := config.Load(path)
			if err != nil {
				return fmt.Errorf("load configuration: %w", err)
			}

			dsn := strings.TrimSpace(cfg.Postgres.DSN)
			if dsn == "" {
				return missingDSNError()
			}

			results, err := applyMigrations(cmd.Context(), cmd, dsn)
			if err != nil {
				return err
			}

			logMigrationResults(cmd, results)
			return nil
		},
	}

	cmd.Flags().StringVar(&configPath, "config", "", "Path to configuration file (optional)")

	return cmd
}

func applyMigrations(ctx context.Context, cmd *cobra.Command, dsn string) ([]*goose.MigrationResult, error) {
	logger := slog.New(slog.NewTextHandler(cmd.ErrOrStderr(), nil))
	results, err := migrate.Up(ctx, dsn, logger)
	if err != nil {
		return nil, wrapMigrationError(err)
	}
	return results, nil
}

func logMigrationResults(cmd *cobra.Command, results []*goose.MigrationResult) {
	for _, result := range results {
		if result == nil || result.Source == nil {
			continue
		}

		state := "applied"
		if result.Empty {
			state = "noop"
		}

		cmd.Printf("migration %06d %s (%s)\n", result.Source.Version, state, filepath.Base(result.Source.Path))
	}
}

func wrapMigrationError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, migrate.ErrMissingDSN) {
		return missingDSNError()
	}
	return fmt.Errorf("run migrations: %w", err)
}

func missingDSNError() error {
	return errors.New(missingDSNMessage)
}
