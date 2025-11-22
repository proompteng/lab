package facteur

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/proompteng/lab/services/facteur/internal/codex"
	"github.com/proompteng/lab/services/facteur/internal/config"
	"github.com/proompteng/lab/services/facteur/internal/messaging"
)

// NewCodexEchoCommand streams structured Codex tasks and logs them.
func NewCodexEchoCommand() *cobra.Command {
	var configPath string

	cmd := &cobra.Command{
		Use:   "codex-listen",
		Short: "Stream structured Codex task messages and echo them to stdout",
		RunE: func(cmd *cobra.Command, _ []string) error {
			path := configPath
			if path == "" {
				path = os.Getenv("FACTEUR_CONFIG_FILE")
			}

			cfg, err := config.Load(path)
			if err != nil {
				return fmt.Errorf("load configuration: %w", err)
			}

			if !cfg.Codex.Enabled {
				return fmt.Errorf("codex listener disabled; set codex_listener.enabled to true")
			}

			reader, err := messaging.NewReader(messaging.ReaderConfig{
				Brokers: cfg.Codex.Brokers,
				Topic:   cfg.Codex.Topic,
				GroupID: cfg.Codex.GroupID,
				Security: messaging.SecurityConfig{
					TLS: messaging.TLSOptions{
						Enabled:            cfg.Codex.TLS.Enabled,
						InsecureSkipVerify: cfg.Codex.TLS.InsecureSkipVerify,
					},
					SASL: messaging.SASLOptions{
						Enabled:   cfg.Codex.SASL.Enabled,
						Mechanism: cfg.Codex.SASL.Mechanism,
						Username:  cfg.Codex.SASL.Username,
						Password:  cfg.Codex.SASL.Password,
					},
				},
			})
			if err != nil {
				return fmt.Errorf("init kafka reader: %w", err)
			}

			logger := log.New(cmd.OutOrStdout(), "", log.LstdFlags)
			listener := codex.NewListener(reader, logger)

			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()

			cmd.Printf("listening to %s (group=%s)\n", cfg.Codex.Topic, cfg.Codex.GroupID)

			if err := listener.Run(ctx); err != nil {
				return err
			}

			cmd.Println("listener stopped")
			return nil
		},
	}

	cmd.Flags().StringVar(&configPath, "config", "", "Path to configuration file (optional)")

	return cmd
}
