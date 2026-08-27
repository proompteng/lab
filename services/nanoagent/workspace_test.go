package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceMapsLogicalWorkspaceIntoPersistentHome(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "workspace"), 0o750); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	t.Cleanup(func() { _ = workspace.close() })

	target, err := workspace.resolveExisting("/workspace")
	if err != nil {
		t.Fatalf("resolveExisting(/workspace) error = %v", err)
	}
	if want := filepath.Join(workspace.realRoot, "workspace"); target != want {
		t.Fatalf("resolveExisting(/workspace) = %q, want %q", target, want)
	}
	if got := workspace.displayPath(target); got != "/workspace" {
		t.Fatalf("displayPath() = %q, want /workspace", got)
	}
}
