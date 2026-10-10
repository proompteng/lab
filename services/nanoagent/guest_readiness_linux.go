//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type guestReadinessTerminal struct {
	command  *exec.Cmd
	terminal *os.File
	sequence uint64
	closed   bool
}

func startGuestReadinessTerminal(directory string, credential *syscall.Credential) (*guestReadinessTerminal, error) {
	command := exec.Command("/bin/bash", "--noprofile", "--norc", "-c",
		`while IFS= read -r challenge; do printf '%s:%s\n' "$challenge" "$$"; done`)
	command.Dir = directory
	command.Env = childEnvironment()
	terminal, err := pty.StartWithAttrs(command, nil, &syscall.SysProcAttr{
		Setsid: true, Setctty: true, Credential: credential,
	})
	if err != nil {
		return nil, fmt.Errorf("prepare guest readiness terminal: %w", err)
	}
	probe := &guestReadinessTerminal{command: command, terminal: terminal}
	settings, err := unix.IoctlGetTermios(int(terminal.Fd()), unix.TCGETS)
	if err == nil {
		settings.Lflag &^= unix.ECHO | unix.ECHONL
		settings.Oflag &^= unix.OPOST
		err = unix.IoctlSetTermios(int(terminal.Fd()), unix.TCSETS, settings)
	}
	if err != nil {
		probe.close()
		return nil, fmt.Errorf("configure guest readiness terminal: %w", err)
	}
	prepared, err := prepareTerminal(terminal)
	if err != nil {
		probe.close()
		return nil, err
	}
	probe.terminal = prepared
	return probe, nil
}

func (probe *guestReadinessTerminal) check() error {
	if probe.closed {
		return errors.New("guest readiness terminal is closed")
	}
	probe.sequence++
	challenge := fmt.Sprintf("tengri-ready-%d", probe.sequence)
	expected := []byte(fmt.Sprintf("%s:%d\n", challenge, probe.command.Process.Pid))
	result := make(chan error, 1)
	go func() {
		_, err := io.WriteString(probe.terminal, challenge+"\n")
		if err == nil {
			var output []byte
			output, err = bufio.NewReaderSize(probe.terminal, 128).ReadSlice('\n')
			if err == nil && !bytes.Equal(output, expected) {
				err = errors.New("guest readiness terminal returned an unexpected challenge or process")
			}
		}
		result <- err
	}()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	var err error
	select {
	case err = <-result:
	case <-timer.C:
		err = context.DeadlineExceeded
	}
	if err != nil {
		probe.close()
		return fmt.Errorf("guest terminal round trip failed: %w", err)
	}
	return nil
}

func (probe *guestReadinessTerminal) close() {
	if probe.closed {
		return
	}
	probe.closed = true
	_ = probe.terminal.Close()
	_ = probe.command.Process.Kill()
	_ = probe.command.Wait()
}
