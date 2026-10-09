//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestUnrecognizedHomeDataIsNeverConsideredBlank(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retained-home")
	contents := []byte("retained files without a recognized filesystem signature")
	if err := os.WriteFile(path, contents, 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyBlankHome(path); err == nil || !strings.Contains(err.Error(), "refusing to format") {
		t.Fatalf("retained data was not rejected: %v", err)
	}
	readback, err := os.ReadFile(path)
	if err != nil || string(readback) != string(contents) {
		t.Fatalf("retained data changed: %v", err)
	}
}

func TestWrongSizedZeroHomeIsNotInitialized(t *testing.T) {
	path := filepath.Join(t.TempDir(), "short-home")
	if err := os.WriteFile(path, make([]byte, 4096), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyBlankHome(path); err == nil || !strings.Contains(err.Error(), "unexpected private home size") {
		t.Fatalf("wrong-sized home was not rejected: %v", err)
	}
}

func TestPrivateHomeRequires32GiB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home")
	disk, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer disk.Close()
	for _, size := range []int64{16 << 30, 32 << 30} {
		if err := disk.Truncate(size); err != nil {
			t.Fatal(err)
		}
		err := verifyHomeSize(path)
		if size == 32<<30 && err != nil {
			t.Fatal(err)
		}
		if size != 32<<30 && (err == nil || !strings.Contains(err.Error(), "unexpected private home size")) {
			t.Fatalf("accepted wrong capacity %d: %v", size, err)
		}
	}
}

func TestResizeRetainedHomePreservesFilesAndFilesystemIdentity(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "home.ext4")
	disk, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer disk.Close()
	if err := disk.Truncate(16 << 30); err != nil {
		t.Fatal(err)
	}
	run := func(command string, args ...string) string {
		t.Helper()
		output, err := exec.Command(command, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v: %s", command, args, err, output)
		}
		return string(output)
	}
	run("/usr/sbin/mkfs.ext4", "-q", "-F", path)
	marker := filepath.Join(directory, "original")
	const contents = "retained workspace and conversation data\n"
	if err := os.WriteFile(marker, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	run("/usr/sbin/debugfs", "-w", "-R", fmt.Sprintf("write %s /original", marker), path)
	uuid := run("/usr/sbin/blkid", "-p", "-o", "value", "-s", "UUID", path)
	if err := disk.Truncate(32 << 30); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := resizeGuestHome(path); err != nil {
			t.Fatal(err)
		}
	}
	if got := run("/usr/sbin/blkid", "-p", "-o", "value", "-s", "UUID", path); got != uuid {
		t.Fatalf("filesystem identity changed: %q != %q", got, uuid)
	}
	if got := run("/usr/sbin/debugfs", "-R", "cat /original", path); !strings.HasSuffix(got, contents) {
		t.Fatalf("retained file changed: %q", got)
	}
	var blocks, blockSize uint64
	for _, line := range strings.Split(run("/usr/sbin/dumpe2fs", "-h", path), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok || (key != "Block count" && key != "Block size") {
			continue
		}
		number, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		if key == "Block count" {
			blocks = number
		} else {
			blockSize = number
		}
	}
	if got := blocks * blockSize; got != 32<<30 {
		t.Fatalf("filesystem has %d bytes, expected 32 GiB", got)
	}
}

func TestResizeHomeRejectsUnrecognizedData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home")
	const contents = "unrecognized retained data"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if err := resizeGuestHome(path); err == nil || !strings.Contains(err.Error(), "grow private home filesystem") {
		t.Fatalf("unrecognized filesystem accepted: %v", err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != contents {
		t.Fatalf("retained data modified: %q, %v", got, err)
	}
}
