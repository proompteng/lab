package facteur

import "github.com/spf13/cobra"

// Execute runs the root command.
func Execute() error {
	return NewRootCommand().Execute()
}

// NewRootCommand configures the top-level CLI command tree.
func NewRootCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "facteur",
		Short: "facteur bridges Discord bot commands to Agents AgentRuns",
	}

	cmd.AddCommand(NewServeCommand())
	cmd.AddCommand(NewMigrateCommand())

	return cmd
}
