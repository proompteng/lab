package facteur

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/proompteng/lab/services/facteur/internal/config"
	"github.com/proompteng/lab/services/facteur/internal/server"
	"github.com/proompteng/lab/services/facteur/internal/session"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

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

			store, err := session.NewRedisStoreFromURL(cfg.Redis.URL)
			if err != nil {
				return fmt.Errorf("init redis store: %w", err)
			}

			dispatcher, err := buildDispatcher(cfg)
			if err != nil {
				return err
			}

			srv, err := server.New(server.Options{
				ListenAddress: cfg.Server.ListenAddress,
				Prefork:       prefork,
				Dispatcher:    dispatcher,
				Store:         store,
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
