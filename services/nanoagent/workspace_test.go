package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceRejectsNonCanonicalPaths(t *testing.T) {
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = workspace.close() })
	for _, path := range []string{"", "/", ".", "/lab/README.md", "/workspace-other/report.txt", "/workspace/", "/workspace//report.txt", "/workspace/../report.txt", "/workspace/./report.txt"} {
		if _, err := workspace.relative(path); !errors.Is(err, errPathOutsideWorkspace) {
			t.Fatalf("noncanonical path %q accepted: %v", path, err)
		}
	}
}

func TestWorkspaceMapsCanonicalPathsIntoPersistentHome(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "workspace"), 0o750); err != nil {
		t.Fatal(err)
	}
	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = workspace.close() })
	for requested, relative := range map[string]string{
		"/workspace":           ".",
		"/workspace/workspace": "workspace",
	} {
		target, err := workspace.resolveExisting(requested)
		if want := filepath.Join(workspace.realRoot, relative); err != nil || target != want {
			t.Fatalf("resolveExisting(%q) = %q, %v; want %q", requested, target, err, want)
		}
		if got := workspace.displayPath(target); got != requested {
			t.Fatalf("displayPath(%q) = %q, want %q", target, got, requested)
		}
	}
}

func TestWorkspacePreservesWhitespaceInRequestedPaths(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"report", "report "} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o600); err != nil {
			t.Fatalf("write %q: %v", name, err)
		}
	}

	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	t.Cleanup(func() { _ = workspace.close() })

	target, err := workspace.resolveExisting("/workspace/report ")
	if err != nil {
		t.Fatalf("resolveExisting(/report<space>) error = %v", err)
	}
	if want := filepath.Join(workspace.realRoot, "report "); target != want {
		t.Fatalf("resolveExisting(/report<space>) = %q, want %q", target, want)
	}
	if got := workspace.displayPath(target); got != "/workspace/report " {
		t.Fatalf("displayPath() = %q, want /report<space>", got)
	}
}

func TestWorkspaceReservesOnlyGeneratedAtomicWriteNames(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{".nanoagent-write-notes", ".nanoagent-write-deadbeef"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o600); err != nil {
			t.Fatalf("write %q: %v", name, err)
		}
	}

	workspace, err := newWorkspace(root)
	if err != nil {
		t.Fatalf("newWorkspace() error = %v", err)
	}
	t.Cleanup(func() { _ = workspace.close() })
	for _, name := range []string{".nanoagent-write-notes", ".nanoagent-write-deadbeef"} {
		if _, err := workspace.resolveExisting("/workspace/" + name); err != nil {
			t.Fatalf("resolveExisting(%q) error = %v", name, err)
		}
		if !workspace.isVisibleAbsolute(filepath.Join(workspace.realRoot, name)) {
			t.Fatalf("user file %q was hidden as internal", name)
		}
	}
	generated := ".nanoagent-write-0123456789abcdef01234567"
	if !isInternalRelativePath(generated) {
		t.Fatalf("generated temporary file %q was visible", generated)
	}
}
