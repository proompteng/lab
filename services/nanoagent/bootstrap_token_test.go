package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

const bootstrapReexecHelperEnvironmentKey = "NANOAGENT_BOOTSTRAP_REEXEC_HELPER"

func TestBootstrapTokenReexecRemovesCredentialFromLongLivedEnvironment(t *testing.T) {
	const token = "bootstrap-token-must-not-remain-in-proc-environ"
	command := exec.Command(os.Args[0], "-test.run=^TestBootstrapTokenReexecHelper$")
	command.Env = append(
		environmentWithoutKeys(
			os.Environ(),
			bootstrapTokenEnvironmentKey,
			bootstrapTokenFDEnvironmentKey,
			bootstrapReexecHelperEnvironmentKey,
		),
		bootstrapReexecHelperEnvironmentKey+"=1",
		bootstrapTokenEnvironmentKey+"="+token,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("bootstrap helper failed: %v\n%s", err, output)
	}
	if bytes.Contains(output, []byte(token)) {
		t.Fatal("bootstrap helper output exposed the credential")
	}
}

func TestBootstrapTokenReexecHelper(t *testing.T) {
	if os.Getenv(bootstrapReexecHelperEnvironmentKey) != "1" {
		t.Skip("bootstrap re-exec helper")
	}
	const token = "bootstrap-token-must-not-remain-in-proc-environ"
	rawFD := os.Getenv(bootstrapTokenFDEnvironmentKey)
	actual, err := loadBootstrapToken()
	if err != nil {
		t.Fatalf("loadBootstrapToken() error = %v", err)
	}
	if actual != token {
		t.Fatal("bootstrap token changed during the re-exec")
	}
	fd, err := strconv.ParseUint(rawFD, 10, 32)
	if err != nil {
		t.Fatalf("parse bootstrap pipe descriptor: %v", err)
	}
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); !errors.Is(err, unix.EBADF) {
		t.Fatalf("bootstrap pipe remained open after loading: %v", err)
	}
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, bootstrapTokenEnvironmentKey+"=") ||
			strings.HasPrefix(item, bootstrapTokenFDEnvironmentKey+"=") {
			t.Fatal("long-lived Nanoagent environment retained bootstrap transport state")
		}
	}
	if runtime.GOOS == "linux" {
		environment, err := os.ReadFile("/proc/self/environ")
		if err != nil && !errors.Is(err, os.ErrPermission) {
			t.Fatalf("read /proc/self/environ: %v", err)
		}
		if err == nil && (bytes.Contains(environment, []byte(token)) ||
			bytes.Contains(environment, []byte(bootstrapTokenEnvironmentKey+"="))) {
			t.Fatal("/proc/self/environ retained the bootstrap credential")
		}
	}
}

func TestEnvironmentWithoutKeysRemovesEveryBlockedOccurrence(t *testing.T) {
	t.Parallel()
	actual := environmentWithoutKeys(
		[]string{
			"PATH=/usr/bin",
			bootstrapTokenEnvironmentKey + "=first",
			bootstrapTokenEnvironmentKey + "=second",
			bootstrapTokenFDEnvironmentKey + "=7",
			"MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained",
		},
		bootstrapTokenEnvironmentKey,
		bootstrapTokenFDEnvironmentKey,
	)
	if strings.Join(actual, "|") != "PATH=/usr/bin|MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained" {
		t.Fatalf("environmentWithoutKeys() = %#v", actual)
	}
}

func TestReadBootstrapTokenFDPreservesCredentialBytes(t *testing.T) {
	t.Parallel()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe() error = %v", err)
	}
	defer reader.Close()

	const token = "  credential-with-significant-space  "
	if _, err := writer.WriteString(token); err != nil {
		t.Fatalf("write bootstrap token: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close bootstrap token writer: %v", err)
	}

	actual, err := readBootstrapTokenFD(duplicateTestFD(t, reader))
	if err != nil {
		t.Fatalf("readBootstrapTokenFD() error = %v", err)
	}
	if _, err := reader.Stat(); err != nil {
		t.Fatalf("readBootstrapTokenFD() closed the test-owned pipe: %v", err)
	}
	if actual != token {
		t.Fatalf("readBootstrapTokenFD() = %q, want exact credential bytes", actual)
	}
}

func TestReadBootstrapTokenFDRejectsRegularFile(t *testing.T) {
	t.Parallel()
	file, err := os.CreateTemp(t.TempDir(), "bootstrap-token")
	if err != nil {
		t.Fatalf("create temporary credential file: %v", err)
	}
	defer file.Close()

	_, err = readBootstrapTokenFD(duplicateTestFD(t, file))
	if err == nil || !strings.Contains(err.Error(), "not a pipe") {
		t.Fatalf("readBootstrapTokenFD() error = %v, want non-pipe rejection", err)
	}
	if _, err := file.Stat(); err != nil {
		t.Fatalf("readBootstrapTokenFD() closed the test-owned file: %v", err)
	}
}

func duplicateTestFD(t *testing.T, file *os.File) string {
	t.Helper()
	fd, err := unix.Dup(int(file.Fd()))
	if err != nil {
		t.Fatalf("duplicate test descriptor: %v", err)
	}

	// readBootstrapTokenFD consumes and closes the descriptor it receives. Tests retain ownership of the original.
	return strconv.Itoa(fd)
}
