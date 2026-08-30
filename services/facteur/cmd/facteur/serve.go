package facteur

import (
	"context"
	"fmt"
	"net/url"
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

var (
	migrationsRunner = applyMigrations
)

// NewServeCommand scaffolds the "serve" CLI command.
func NewServeCommand() *cobra.Command {
	var (
		configPath string
		prefork    bool
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the facteur Discord to Agents bridge server",
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

			cmd.Printf(
				"config: dispatch_target=agents agents_url=%s agent_namespace=%s agent=%s redis=%s postgres=%s listen=%s\n",
				cfg.Implementer.AgentsBaseURL,
				cfg.Implementer.Namespace,
				cfg.Implementer.AgentName,
				redactURL(cfg.Redis.URL),
				redactURL(cfg.Postgres.DSN),
				cfg.Server.ListenAddress,
			)

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

			results, err := migrationsRunner(cmd.Context(), cmd, cfg.Postgres.DSN)
			if err != nil {
				return err
			}
			logMigrationResults(cmd, results)

			sessionStore, err := session.NewRedisStoreFromURL(cfg.Redis.URL)
			if err != nil {
				return fmt.Errorf("init redis store: %w", err)
			}

			dispatcher, _, err := buildDispatcher(cfg)
			if err != nil {
				return err
			}

			srv, err := server.New(server.Options{
				ListenAddress: cfg.Server.ListenAddress,
				Prefork:       prefork,
				Dispatcher:    dispatcher,
				Store:         sessionStore,
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

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}
	cloned := make(map[string]string, len(input))
	for k, v := range input {
		cloned[k] = v
	}
	return cloned
}

func redactURL(raw string) string {
	if raw == "" {
		return ""
	}

	parsed, err := url.Parse(raw)
	if err != nil || parsed.User == nil {
		return raw
	}

	user := parsed.User.Username()
	passwordSet := parsed.User.String() != user
	if passwordSet {
		parsed.User = url.UserPassword(user, "***")
	} else {
		parsed.User = url.User(user)
	}

	return parsed.String()
}
