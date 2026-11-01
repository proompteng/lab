//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func codexProcessCommand(binary string, arguments []string, workspace, generation string) (*exec.Cmd, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return exec.Command(self, append([]string{"codex-process", generation, workspace, strconv.Itoa(os.Getpid()), binary}, arguments...)...), nil
}

func stopCodexProcess(command *exec.Cmd) {
	if command != nil && command.Process != nil {
		_ = command.Process.Signal(syscall.SIGTERM)
	}
}

func runCodexProcess(arguments []string) error {
	if len(arguments) < 4 || !validCodexGeneration(arguments[0]) || !filepath.IsAbs(arguments[1]) {
		return errors.New("invalid Codex process identity")
	}
	parent, err := strconv.Atoi(arguments[2])
	if err != nil || parent <= 0 || os.Getppid() != parent {
		return errors.New("Codex supervisor parent is unavailable")
	}
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("own Codex child processes: %w", err)
	}
	boot, err := os.ReadFile(bootIDPath)
	if err != nil || !codexOperationID.MatchString(strings.TrimSpace(string(boot))) {
		return errors.New("Codex kernel boot identity is unavailable")
	}
	receipt := codexGenerationReceipt{Version: 1, Generation: arguments[0], BootID: strings.TrimSpace(string(boot))}
	path := codexGenerationPath(arguments[1], receipt.Generation)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := writeCodexReceipt(path, receipt); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != parent {
					cancel()
					return
				}
			}
		}
	}()
	command := exec.Command(arguments[3], arguments[4:]...)
	command.Dir = arguments[1]
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = command.Process.Kill()
		err = <-done
	}
	if cleanupErr := reapCodexChildren(); cleanupErr != nil {
		return cleanupErr
	}
	receipt.ProcessesStopped = true
	if saveErr := writeCodexReceipt(path, receipt); saveErr != nil {
		return saveErr
	}
	return err
}

func reapCodexChildren() error {
	deadline := time.Now().Add(15 * time.Second)
	for {
		tasks, err := os.ReadDir("/proc/self/task")
		if err != nil {
			return err
		}
		for _, task := range tasks {
			content, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "children"))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			for _, value := range strings.Fields(string(content)) {
				pid, err := strconv.Atoi(value)
				if err != nil || pid <= 0 {
					return errors.New("invalid Codex child identity")
				}
				identity, err := readProcessIdentity("/proc", pid)
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				if err != nil {
					return err
				}
				if err := signalPinnedProcessIdentity("/proc", identity, syscall.SIGKILL); err != nil {
					return err
				}
			}
		}
		for {
			pid, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
			if errors.Is(err, syscall.ECHILD) {
				return nil
			}
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if err != nil {
				return err
			}
			if pid == 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			return errors.New("Codex child termination could not be confirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
