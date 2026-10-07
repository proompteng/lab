//go:build linux

package main

import (
	"os"
	"path/filepath"
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
