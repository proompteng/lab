package facteur

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/proompteng/lab/services/facteur/internal/config"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
	"github.com/proompteng/lab/services/facteur/internal/server"
	"github.com/proompteng/lab/services/facteur/internal/session"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

var postgresOpener = openPostgres

// NewServeCommand scaffolds the "serve" CLI command.
func NewServeCommand() *cobra.Command {
	var (
		configPath string
		prefork    bool
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the facteur Discord ↔ Argo bridge server",
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
			cfg.Postgres.DSN = dsn

			teleShutdown, err := telemetry.Setup(cmd.Context(), "facteur", "")
			if err != nil {
				return fmt.Errorf("init telemetry: %w", err)
			}
			defer func() {
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()

				if flushErr := telemetry.ForceFlush(shutdownCtx); flushErr != nil {
					cmd.PrintErrf("telemetry force flush: %v\n", flushErr)
				}
				if shutdownErr := teleShutdown(shutdownCtx); shutdownErr != nil {
					cmd.PrintErrf("telemetry shutdown: %v\n", shutdownErr)
				}
			}()

			results, err := applyMigrations(cmd.Context(), cmd, cfg.Postgres.DSN)
			if err != nil {
				return err
			}
			logMigrationResults(cmd, results)

			sessionStore, err := session.NewRedisStoreFromURL(cfg.Redis.URL)
			if err != nil {
				return fmt.Errorf("init redis store: %w", err)
			}

			db, err := postgresOpener(cmd.Context(), cfg.Postgres.DSN)
			if err != nil {
				return err
			}
			defer func() {
				if closeErr := db.Close(); closeErr != nil {
					cmd.PrintErrf("close postgres: %v\n", closeErr)
				}
			}()

			kbStore := knowledge.NewStore(db)

			dispatcher, err := buildDispatcher(cfg)
			if err != nil {
				return err
			}

			srv, err := server.New(server.Options{
				ListenAddress: cfg.Server.ListenAddress,
				Prefork:       prefork,
				Dispatcher:    dispatcher,
				Store:         sessionStore,
				CodexStore:    kbStore,
			})
			if err != nil {
				return fmt.Errorf("init server: %w", err)
			}

			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()

			cmd.Printf("facteur listening on %s\n", cfg.Server.ListenAddress)

			if err := srv.Run(ctx); err != nil {
				return err
			}

			cmd.Println("facteur server exited")
			return nil
		},
	}

	cmd.Flags().StringVar(&configPath, "config", "", "Path to configuration file (optional)")
	cmd.Flags().BoolVar(&prefork, "prefork", false, "Enable Fiber prefork mode for maximised throughput")

	return cmd
}

func openPostgres(ctx context.Context, dsn string) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}

	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(10)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(60 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := db.PingContext(pingCtx); err != nil {
		closeErr := db.Close()
		if closeErr != nil {
			return nil, fmt.Errorf("ping postgres: %v (close error: %w)", err, closeErr)
		}
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	return db, nil
}
