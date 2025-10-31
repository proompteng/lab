package facteur

import (
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNewRootCommandRegistersSubcommands(t *testing.T) {
	cmd := NewRootCommand()
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"--help"})

	err := cmd.Execute()
	require.NoError(t, err)

	names := map[string]struct{}{}
	for _, child := range cmd.Commands() {
		names[child.Name()] = struct{}{}
	}

	for _, expected := range []string{"serve", "migrate", "codex-listen"} {
		_, ok := names[expected]
		require.Truef(t, ok, "expected %s command to be registered", expected)
	}
}

func TestExecuteHonoursDefaultArgs(t *testing.T) {
	origArgs := os.Args
	origStdout := os.Stdout
	origStderr := os.Stderr
	defer func() {
		os.Args = origArgs
		os.Stdout = origStdout
		os.Stderr = origStderr
	}()

	os.Args = []string{"facteur", "--help"}

	stdoutR, stdoutW, err := os.Pipe()
	require.NoError(t, err)
	stderrR, stderrW, err := os.Pipe()
	require.NoError(t, err)

	os.Stdout = stdoutW
	os.Stderr = stderrW

	require.NoError(t, Execute())

	_ = stdoutW.Close()
	_ = stderrW.Close()
	_ = stdoutR.Close()
	_ = stderrR.Close()
}
