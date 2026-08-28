package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type fileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Directory  bool   `json:"directory"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}

type fileList struct {
	Path    string      `json:"path"`
	Entries []fileEntry `json:"entries"`
}

type writeFileRequest struct {
	Content string `json:"content"`
	Path    string `json:"path"`
}

type writeFileResponse struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type pathRequest struct {
	Path string `json:"path"`
}

type moveFileRequest struct {
	DestinationPath string `json:"destinationPath"`
	SourcePath      string `json:"sourcePath"`
}

type deleteFileRequest struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type searchFilesResponse struct {
	Entries   []fileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

var errTooManyDirectoryEntries = errors.New("directory exceeds the 10,000 entry Finder limit")

const maxSearchVisitedEntries = 50_000

var workspaceSearchExcludedRootNames = map[string]struct{}{
	".bun":   {},
	".cache": {},
	".cargo": {},
	".local": {},
}

func (server *apiServer) handleListFiles(writer http.ResponseWriter, request *http.Request) {
	requested := request.URL.Query().Get("path")
	if _, err := server.workspace.resolveExisting(requested); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	relative, err := server.workspace.relative(requested)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	directory, err := server.workspace.safeRoot.Open(relative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if !info.IsDir() {
		writeAPIError(writer, http.StatusBadRequest, "path is not a directory")
		return
	}
	entries, err := readDirectoryEntries(directory, maxDirectoryEntries)
	if err != nil {
		if errors.Is(err, errTooManyDirectoryEntries) {
			writeAPIError(writer, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		writeWorkspaceError(writer, err)
		return
	}
	result := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		item, itemErr := server.fileEntryRelative(filepath.Join(relative, entry.Name()))
		if itemErr == nil {
			result = append(result, item)
		}
	}
	sortFileEntries(result)
	writeJSON(writer, http.StatusOK, fileList{Path: server.workspace.displayRelative(relative), Entries: result})
}

func readDirectoryEntries(directory *os.File, limit int) ([]os.DirEntry, error) {
	entries, err := directory.ReadDir(limit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > limit {
		return nil, errTooManyDirectoryEntries
	}
	return entries, nil
}

func (server *apiServer) handleReadFile(writer http.ResponseWriter, request *http.Request) {
	requested := request.URL.Query().Get("path")
	if _, err := server.workspace.resolveExisting(requested); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	relative, err := server.workspace.relative(requested)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	file, err := server.workspace.safeRoot.Open(relative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if !info.Mode().IsRegular() {
		writeAPIError(writer, http.StatusBadRequest, "path is not a regular file")
		return
	}
	if info.Size() > maxFileBytes {
		writeAPIError(writer, http.StatusRequestEntityTooLarge, "file exceeds the 4 MiB editor limit")
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if len(content) > maxFileBytes {
		writeAPIError(writer, http.StatusRequestEntityTooLarge, "file exceeds the 4 MiB editor limit")
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(relative))
	if contentType == "" {
		contentType = http.DetectContentType(content)
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}

func (server *apiServer) handleWriteFile(writer http.ResponseWriter, request *http.Request) {
	var input writeFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	content, err := base64.StdEncoding.DecodeString(input.Content)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "content must be base64 encoded")
		return
	}
	if len(content) > maxFileBytes {
		writeAPIError(writer, http.StatusRequestEntityTooLarge, "file exceeds the 4 MiB editor limit")
		return
	}
	target, err := server.workspace.resolveForWrite(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if target == server.workspace.root {
		writeAPIError(writer, http.StatusBadRequest, "cannot overwrite the home root")
		return
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	parent := filepath.Dir(relative)
	if err := server.workspace.safeRoot.MkdirAll(parent, 0o750); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	mode := os.FileMode(0o640)
	if existing, statErr := server.workspace.safeRoot.Stat(relative); statErr == nil {
		if !existing.Mode().IsRegular() {
			writeAPIError(writer, http.StatusBadRequest, "path is not a regular file")
			return
		}
		mode = existing.Mode().Perm()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		writeWorkspaceError(writer, statErr)
		return
	}
	temporaryName, temporary, err := createWorkspaceTemporaryFile(server.workspace, parent, mode)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	defer server.workspace.safeRoot.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		writeWorkspaceError(writer, err)
		return
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		writeWorkspaceError(writer, err)
		return
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		writeWorkspaceError(writer, err)
		return
	}
	if err := temporary.Close(); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if err := server.workspace.safeRoot.Rename(temporaryName, relative); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	syncWorkspaceDirectory(server.workspace, parent)
	writeJSON(writer, http.StatusOK, writeFileResponse{Path: server.workspace.displayRelative(relative), Size: int64(len(content))})
}

func (server *apiServer) handleCreateDirectory(writer http.ResponseWriter, request *http.Request) {
	var input pathRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	target, err := server.workspace.resolveForWrite(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if target == server.workspace.root {
		writeAPIError(writer, http.StatusConflict, "home root already exists")
		return
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if _, err := server.workspace.safeRoot.Lstat(relative); err == nil {
		writeAPIError(writer, http.StatusConflict, "path already exists")
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		writeWorkspaceError(writer, err)
		return
	}
	if err := server.workspace.safeRoot.MkdirAll(relative, 0o750); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	entry, err := server.fileEntryRelative(relative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, entry)
}

func (server *apiServer) handleMoveFile(writer http.ResponseWriter, request *http.Request) {
	var input moveFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	source, err := server.workspace.resolveExisting(input.SourcePath)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if source == server.workspace.realRoot {
		writeAPIError(writer, http.StatusBadRequest, "cannot move the home root")
		return
	}
	sourceRelative, err := server.workspace.relative(input.SourcePath)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	logicalSource := filepath.Join(server.workspace.realRoot, sourceRelative)
	sourceInfo, err := server.workspace.safeRoot.Lstat(sourceRelative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	rawSource := source
	if sourceInfo.Mode()&os.ModeSymlink != 0 {
		// Rename moves a leaf symlink entry rather than its target, but fsnotify
		// still reports that entry beneath the canonical parent directory.
		rawSourceParent, err := filepath.EvalSymlinks(filepath.Dir(logicalSource))
		if err != nil {
			writeWorkspaceError(writer, err)
			return
		}
		rawSource = filepath.Join(rawSourceParent, filepath.Base(logicalSource))
	}
	destination, err := server.workspace.resolveForWrite(input.DestinationPath)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if destination == server.workspace.root {
		writeAPIError(writer, http.StatusBadRequest, "cannot replace the home root")
		return
	}
	destinationRelative, err := server.workspace.relative(input.DestinationPath)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if _, err := server.workspace.safeRoot.Lstat(destinationRelative); err == nil {
		writeAPIError(writer, http.StatusConflict, "destination already exists")
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		writeWorkspaceError(writer, err)
		return
	}
	if err := server.workspace.safeRoot.MkdirAll(filepath.Dir(destinationRelative), 0o750); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	logicalDestination := filepath.Join(server.workspace.realRoot, destinationRelative)
	rawDestinationParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	rawDestination := filepath.Join(rawDestinationParent, filepath.Base(destination))
	renameGeneration, err := server.fileWatcher.beginPairedRenamePaths(
		logicalSource,
		rawSource,
		logicalDestination,
		rawDestination,
	)
	if err != nil {
		writeAPIError(writer, http.StatusConflict, err.Error())
		return
	}
	renamePublished := false
	defer func() {
		if !renamePublished {
			server.fileWatcher.cancelPairedRename(logicalSource, renameGeneration)
		}
	}()
	if err := server.workspace.safeRoot.Rename(sourceRelative, destinationRelative); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	destinationPath := server.workspace.displayRelative(destinationRelative)
	entry, err := server.fileEntryRelative(destinationRelative)
	if err != nil {
		server.fileWatcher.publishPairedRename(logicalSource, renameGeneration, fileEvent{Path: destinationPath})
		renamePublished = true
		writeWorkspaceError(writer, err)
		return
	}
	server.fileWatcher.publishPairedRename(logicalSource, renameGeneration, fileEvent{Path: entry.Path, Entry: &entry})
	renamePublished = true
	writeJSON(writer, http.StatusOK, entry)
}

func (server *apiServer) handleDeleteFile(writer http.ResponseWriter, request *http.Request) {
	var input deleteFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	target, err := server.workspace.resolveExisting(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if target == server.workspace.realRoot {
		writeAPIError(writer, http.StatusBadRequest, "cannot delete the home root")
		return
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	info, err := server.workspace.safeRoot.Lstat(relative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if info.IsDir() && input.Recursive {
		err = server.workspace.safeRoot.RemoveAll(relative)
	} else {
		err = server.workspace.safeRoot.Remove(relative)
	}
	if err != nil {
		if info.IsDir() && !input.Recursive {
			writeAPIError(writer, http.StatusConflict, "directory is not empty; recursive deletion was not authorized")
			return
		}
		writeWorkspaceError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *apiServer) handleSearchFiles(writer http.ResponseWriter, request *http.Request) {
	query := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("query")))
	if query == "" || len(query) > 256 {
		writeAPIError(writer, http.StatusBadRequest, "query must contain between 1 and 256 characters")
		return
	}
	root, err := server.workspace.resolveExisting(request.URL.Query().Get("path"))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	limit := 100
	if value := request.URL.Query().Get("limit"); value != "" {
		if parsed, parseErr := parseBoundedInt(value, 1, 200); parseErr == nil {
			limit = parsed
		} else {
			writeAPIError(writer, http.StatusBadRequest, "limit must be between 1 and 200")
			return
		}
	}
	result, err := server.searchFiles(request.Context(), root, query, limit, maxSearchVisitedEntries)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (server *apiServer) searchFiles(
	ctx context.Context,
	root string,
	query string,
	limit int,
	visitedLimit int,
) (searchFilesResponse, error) {
	result := searchFilesResponse{Entries: make([]fileEntry, 0, limit)}
	visited := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if requestErr := ctx.Err(); requestErr != nil {
			return requestErr
		}
		if walkErr != nil {
			return nil
		}
		if root == server.workspace.realRoot && path != root && entry.IsDir() && filepath.Dir(path) == root {
			if _, excluded := workspaceSearchExcludedRootNames[entry.Name()]; excluded {
				return filepath.SkipDir
			}
		}
		if path != root && !server.workspace.isVisibleAbsolute(path) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if path == root {
			return nil
		}

		visited++
		if visited > visitedLimit {
			result.Truncated = true
			return filepath.SkipAll
		}
		if !strings.Contains(strings.ToLower(entry.Name()), query) {
			return nil
		}
		item, itemErr := server.fileEntry(path)
		if itemErr != nil {
			return nil
		}
		if len(result.Entries) >= limit {
			result.Truncated = true
			return filepath.SkipAll
		}
		result.Entries = append(result.Entries, item)
		return nil
	})
	if err != nil {
		return searchFilesResponse{}, err
	}
	sortFileEntries(result.Entries)
	return result, nil
}

func (server *apiServer) fileEntry(path string) (fileEntry, error) {
	relative, err := server.workspace.relativeFromAbsolute(path)
	if err != nil {
		return fileEntry{}, err
	}
	return server.fileEntryRelative(relative)
}

func (server *apiServer) fileEntryRelative(relative string) (fileEntry, error) {
	if isInternalRelativePath(relative) {
		return fileEntry{}, errInternalPath
	}
	if _, err := server.workspace.resolveExisting(server.workspace.displayRelative(relative)); err != nil {
		return fileEntry{}, err
	}
	info, err := server.workspace.safeRoot.Stat(relative)
	if err != nil {
		return fileEntry{}, err
	}
	return fileEntry{
		Name:       filepath.Base(relative),
		Path:       server.workspace.displayRelative(relative),
		Directory:  info.IsDir(),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(timeFormat),
	}, nil
}

func createWorkspaceTemporaryFile(workspace workspace, parent string, mode os.FileMode) (string, *os.File, error) {
	for range 16 {
		var suffix [12]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return "", nil, fmt.Errorf("generate temporary file name: %w", err)
		}
		name := filepath.Join(parent, fmt.Sprintf("%s%x", workspaceTemporaryFilePrefix, suffix))
		file, err := workspace.safeRoot.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err == nil {
			return name, file, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", nil, err
		}
	}
	return "", nil, errors.New("could not allocate a unique temporary file")
}

func syncWorkspaceDirectory(workspace workspace, relative string) {
	directory, err := workspace.safeRoot.Open(relative)
	if err != nil {
		return
	}
	defer directory.Close()
	_ = directory.Sync()
}

func sortFileEntries(entries []fileEntry) {
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Directory != entries[right].Directory {
			return entries[left].Directory
		}
		return strings.ToLower(entries[left].Name) < strings.ToLower(entries[right].Name)
	})
}

func writeWorkspaceError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInternalPath):
		writeAPIError(writer, http.StatusNotFound, "path is not visible")
	case errors.Is(err, errPathOutsideWorkspace):
		writeAPIError(writer, http.StatusForbidden, "path must remain inside the user home")
	case errors.Is(err, os.ErrNotExist):
		writeAPIError(writer, http.StatusNotFound, "path does not exist")
	case errors.Is(err, os.ErrPermission):
		writeAPIError(writer, http.StatusForbidden, "path is not accessible")
	default:
		writeAPIError(writer, http.StatusInternalServerError, "filesystem operation failed")
	}
}

const timeFormat = "2006-01-02T15:04:05.000Z07:00"
