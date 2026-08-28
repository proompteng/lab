package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var (
	errInternalPath         = errors.New("path is reserved for Tengri infrastructure")
	errPathOutsideWorkspace = errors.New("path escapes the workspace")
)

const workspaceTemporaryFilePrefix = ".nanoagent-write-"

var internalPathNames = map[string]struct{}{
	".codex":  {},
	".tengri": {},
}

type workspace struct {
	realRoot string
	root     string
	safeRoot *os.Root
}

func newWorkspace(root string) (workspace, error) {
	if strings.TrimSpace(root) == "" {
		return workspace{}, errors.New("workspace root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return workspace{}, fmt.Errorf("resolve workspace root: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o750); err != nil {
		return workspace{}, fmt.Errorf("create workspace root: %w", err)
	}
	realRoot, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return workspace{}, fmt.Errorf("resolve workspace symlinks: %w", err)
	}
	safeRoot, err := os.OpenRoot(realRoot)
	if err != nil {
		return workspace{}, fmt.Errorf("open confined workspace root: %w", err)
	}
	return workspace{root: absolute, realRoot: realRoot, safeRoot: safeRoot}, nil
}

func (workspace workspace) close() error {
	return workspace.safeRoot.Close()
}

func (workspace workspace) relative(requested string) (string, error) {
	if requested == "" || requested == "/" || requested == "." {
		return ".", nil
	}
	relative := filepath.Clean(strings.TrimPrefix(requested, "/"))
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errPathOutsideWorkspace
	}
	if isInternalRelativePath(relative) {
		return "", errInternalPath
	}
	return relative, nil
}

func (workspace workspace) relativeFromAbsolute(absolute string) (string, error) {
	relative, err := filepath.Rel(workspace.realRoot, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errPathOutsideWorkspace
	}
	if isInternalRelativePath(relative) {
		return "", errInternalPath
	}
	if relative == "" {
		return ".", nil
	}
	return relative, nil
}

func (workspace workspace) displayRelative(relative string) string {
	if relative == "" || relative == "." {
		return "/"
	}
	return "/" + filepath.ToSlash(relative)
}

func (workspace workspace) resolveExisting(requested string) (string, error) {
	target, err := workspace.clean(requested)
	if err != nil {
		return "", err
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	if !pathWithin(workspace.realRoot, realTarget) {
		return "", errPathOutsideWorkspace
	}
	if !workspace.isVisibleAbsolute(realTarget) {
		return "", errInternalPath
	}
	return realTarget, nil
}

func (workspace workspace) resolveForWrite(requested string) (string, error) {
	target, err := workspace.clean(requested)
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(target)
	existingParent := parent
	for {
		_, statErr := os.Lstat(existingParent)
		if statErr == nil {
			break
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		next := filepath.Dir(existingParent)
		if next == existingParent {
			return "", errPathOutsideWorkspace
		}
		existingParent = next
	}
	realParent, err := filepath.EvalSymlinks(existingParent)
	if err != nil {
		return "", err
	}
	if !pathWithin(workspace.realRoot, realParent) {
		return "", errPathOutsideWorkspace
	}
	if !workspace.isVisibleAbsolute(realParent) {
		return "", errInternalPath
	}
	return target, nil
}

func (workspace workspace) clean(requested string) (string, error) {
	relative, err := workspace.relative(requested)
	if err != nil {
		return "", err
	}
	if relative == "." {
		return workspace.root, nil
	}
	target := filepath.Join(workspace.root, relative)
	if !pathWithin(workspace.root, target) {
		return "", errPathOutsideWorkspace
	}
	return target, nil
}

func isInternalRelativePath(relative string) bool {
	for _, part := range strings.Split(filepath.Clean(relative), string(filepath.Separator)) {
		if _, internal := internalPathNames[part]; internal {
			return true
		}
		if isWorkspaceTemporaryFileName(part) {
			return true
		}
	}
	return false
}

func isWorkspaceTemporaryFileName(name string) bool {
	if !strings.HasPrefix(name, workspaceTemporaryFilePrefix) {
		return false
	}
	suffix := strings.TrimPrefix(name, workspaceTemporaryFilePrefix)
	if len(suffix) != 24 {
		return false
	}
	for _, character := range []byte(suffix) {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func (workspace workspace) isVisibleAbsolute(absolute string) bool {
	relative, err := filepath.Rel(workspace.realRoot, absolute)
	return err == nil && !isInternalRelativePath(relative)
}

func (workspace workspace) displayPath(absolute string) string {
	relative, err := filepath.Rel(workspace.realRoot, absolute)
	if err != nil || relative == "." {
		return "/"
	}
	return "/" + filepath.ToSlash(relative)
}

func pathWithin(root string, target string) bool {
	relative, err := filepath.Rel(root, target)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
