//go:build !linux

package main

import (
	"errors"
	"os/exec"
)

func codexProcessCommand(binary string, arguments []string, _, _ string) (*exec.Cmd, error) {
	return exec.Command(binary, arguments...), nil
}

func stopCodexProcess(command *exec.Cmd) {
	killProcessGroup(command)
}

func runCodexProcess(_ []string) error {
	return errors.New("Codex descendant cleanup requires Linux")
}
