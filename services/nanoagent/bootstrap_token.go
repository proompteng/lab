package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	bootstrapTokenEnvironmentKey   = "MICROVM_BOOTSTRAP_TOKEN"
	bootstrapTokenFDEnvironmentKey = "MICROVM_BOOTSTRAP_TOKEN_FD"
	reexecWrapperEnvironmentKey    = "NANOAGENT_REEXEC_WRAPPER"
	maxBootstrapTokenBytes         = 4 << 10
)

// loadBootstrapToken replaces the short-lived container entry process before
// starting any guest API or terminal. The replacement process receives the
// credential through a one-use anonymous pipe, so its initial environment and
// /proc/<pid>/environ never contain the token.
func loadBootstrapToken() (string, error) {
	fdValue := strings.TrimSpace(os.Getenv(bootstrapTokenFDEnvironmentKey))
	token := os.Getenv(bootstrapTokenEnvironmentKey)
	if fdValue != "" {
		if token != "" {
			return "", errors.New("bootstrap token environment and file descriptor are both configured")
		}
		if err := hardenProcessMemory(); err != nil {
			return "", err
		}
		return readBootstrapTokenFD(fdValue)
	}

	if strings.TrimSpace(token) == "" {
		return "", errors.New("MICROVM_BOOTSTRAP_TOKEN is required for the bootstrap re-exec")
	}
	if len(token) > maxBootstrapTokenBytes {
		return "", errors.New("bootstrap token exceeds the maximum size")
	}
	return "", reexecWithBootstrapToken(token)
}

func reexecWithBootstrapToken(token string) error {
	reader, writer, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create bootstrap token pipe: %w", err)
	}
	defer reader.Close()

	if _, err := unix.FcntlInt(reader.Fd(), unix.F_SETFD, 0); err != nil {
		_ = writer.Close()
		return fmt.Errorf("make bootstrap token pipe inheritable: %w", err)
	}
	if _, err := io.WriteString(writer, token); err != nil {
		_ = writer.Close()
		return fmt.Errorf("write bootstrap token pipe: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("close bootstrap token pipe writer: %w", err)
	}

	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Nanoagent executable: %w", err)
	}
	reexecTarget := executable
	reexecArguments := os.Args
	wrapper := strings.TrimSpace(os.Getenv(reexecWrapperEnvironmentKey))
	if wrapper != "" {
		if !filepath.IsAbs(wrapper) {
			return errors.New("NANOAGENT_REEXEC_WRAPPER must be an absolute path")
		}
		reexecTarget = wrapper
		reexecArguments = append([]string{wrapper, "-s", "--", executable}, os.Args[1:]...)
	}
	environment := environmentWithoutKeys(
		os.Environ(),
		bootstrapTokenEnvironmentKey,
		bootstrapTokenFDEnvironmentKey,
		reexecWrapperEnvironmentKey,
	)
	environment = append(environment, fmt.Sprintf("%s=%d", bootstrapTokenFDEnvironmentKey, reader.Fd()))
	if err := syscall.Exec(reexecTarget, reexecArguments, environment); err != nil {
		return fmt.Errorf("replace Nanoagent bootstrap process: %w", err)
	}
	return errors.New("Nanoagent bootstrap re-exec returned unexpectedly")
}

func readBootstrapTokenFD(rawFD string) (string, error) {
	fd, err := strconv.ParseUint(rawFD, 10, 32)
	if err != nil || fd < 3 {
		return "", errors.New("bootstrap token file descriptor is invalid")
	}
	file := os.NewFile(uintptr(fd), "nanoagent-bootstrap-token")
	if file == nil {
		return "", errors.New("bootstrap token file descriptor is unavailable")
	}
	defer file.Close()
	_ = os.Unsetenv(bootstrapTokenFDEnvironmentKey)
	_ = os.Unsetenv(reexecWrapperEnvironmentKey)
	info, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("inspect bootstrap token pipe: %w", err)
	}
	if info.Mode()&os.ModeNamedPipe == 0 {
		return "", errors.New("bootstrap token file descriptor is not a pipe")
	}

	contents, err := io.ReadAll(io.LimitReader(file, maxBootstrapTokenBytes+1))
	if err != nil {
		return "", fmt.Errorf("read bootstrap token pipe: %w", err)
	}
	if len(contents) > maxBootstrapTokenBytes {
		return "", errors.New("bootstrap token exceeds the maximum size")
	}
	token := string(contents)
	clear(contents)
	if strings.TrimSpace(token) == "" {
		return "", errors.New("bootstrap token pipe is empty")
	}
	return token, nil
}

func environmentWithoutKeys(source []string, blockedKeys ...string) []string {
	blocked := make(map[string]struct{}, len(blockedKeys))
	for _, key := range blockedKeys {
		blocked[key] = struct{}{}
	}

	result := make([]string, 0, len(source))
	for _, item := range source {
		key, _, found := strings.Cut(item, "=")
		if _, rejected := blocked[key]; found && rejected {
			continue
		}
		result = append(result, item)
	}
	return result
}
