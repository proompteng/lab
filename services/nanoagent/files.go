package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
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
	Content          string `json:"content"`
	ExpectedRevision string `json:"expectedRevision"`
	Path             string `json:"path"`
}

type writeFileResponse struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Revision string `json:"revision"`
}

type revisionConflictResponse struct {
	Error           string `json:"error"`
	CurrentRevision string `json:"currentRevision,omitempty"`
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

var (
	errTooManyDirectoryEntries = errors.New("directory exceeds the 10,000 entry Finder limit")
	errFileTooLarge            = errors.New("file exceeds the 4 MiB editor limit")
	errNotRegularFile          = errors.New("path is not a regular file")
	errNotDirectory            = errors.New("path is not a directory")
)

const (
	maxSearchVisitedEntries = 50_000
	fileRevisionLength      = sha256.Size * 2
	missingFileRevision     = "missing"
)

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

type fileReadSnapshot struct {
	content     []byte
	contentType string
	revision    string
}

func (server *apiServer) readFileSnapshot(requested string) (fileReadSnapshot, error) {
	server.fileMutationMu.RLock()
	defer server.fileMutationMu.RUnlock()

	if _, err := server.workspace.resolveExisting(requested); err != nil {
		return fileReadSnapshot{}, err
	}
	relative, err := server.workspace.relative(requested)
	if err != nil {
		return fileReadSnapshot{}, err
	}
	file, info, err := server.openRegularFile(relative)
	if err != nil {
		return fileReadSnapshot{}, err
	}
	defer file.Close()
	if info.Size() > maxFileBytes {
		return fileReadSnapshot{}, errFileTooLarge
	}
	content, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil {
		return fileReadSnapshot{}, err
	}
	if len(content) > maxFileBytes {
		return fileReadSnapshot{}, errFileTooLarge
	}
	revision := revisionForContent(content)
	contentType := mime.TypeByExtension(filepath.Ext(relative))
	if contentType == "" {
		contentType = http.DetectContentType(content)
	}
	return fileReadSnapshot{content: content, contentType: contentType, revision: revision}, nil
}

func (server *apiServer) handleReadFile(writer http.ResponseWriter, request *http.Request) {
	snapshot, err := server.readFileSnapshot(request.URL.Query().Get("path"))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writer.Header().Set("Content-Type", snapshot.contentType)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("ETag", `"`+snapshot.revision+`"`)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(snapshot.content)
}

func (server *apiServer) handleWriteFile(writer http.ResponseWriter, request *http.Request) {
	var input writeFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	if !isValidExpectedRevision(input.ExpectedRevision) {
		writeAPIError(writer, http.StatusBadRequest, "expectedRevision must be a lowercase SHA256 or missing")
		return
	}
	content, err := base64.StdEncoding.DecodeString(input.Content)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "content must be base64 encoded")
		return
	}
	if len(content) > maxFileBytes {
		writeAPIError(writer, http.StatusRequestEntityTooLarge, errFileTooLarge.Error())
		return
	}

	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()
	// This lock serializes Nanoagent API writers. Direct filesystem writers
	// outside this process are not participants in the check-and-rename
	// protocol, so expectedRevision remains a content snapshot for them.

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
	state, err := server.fileRevisionState(relative)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	if state.revision != input.ExpectedRevision {
		writeRevisionConflict(writer, state.revision)
		return
	}
	parent := filepath.Dir(relative)
	if err := server.workspace.safeRoot.MkdirAll(parent, 0o750); err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	mode := os.FileMode(0o640)
	if state.exists {
		mode = state.mode.Perm()
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
	if err := server.syncMutationDirectories(parent); err != nil {
		// Rename has already made the new content visible. A failed parent sync
		// makes durability unknown; do not remove or otherwise roll back it.
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, writeFileResponse{
		Path:     server.workspace.displayRelative(relative),
		Size:     int64(len(content)),
		Revision: revisionForContent(content),
	})
}

func (server *apiServer) handleCreateDirectory(writer http.ResponseWriter, request *http.Request) {
	var input pathRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

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
	if err := server.syncMutationDirectories(relative); err != nil {
		// The directory is already visible. A failed sync leaves its durable
		// acknowledgement unknown, so leave the mutation in place.
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
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

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
	} else {
		server.fileWatcher.publishPairedRename(logicalSource, renameGeneration, fileEvent{Path: entry.Path, Entry: &entry})
		renamePublished = true
	}
	if syncErr := server.syncMutationDirectories(
		filepath.Dir(sourceRelative),
		filepath.Dir(destinationRelative),
	); syncErr != nil {
		// Rename and the watcher event have already completed. A failed parent
		// sync makes durability unknown; never attempt a compensating rename.
		writeWorkspaceError(writer, syncErr)
		return
	}
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, entry)
}

func (server *apiServer) handleDeleteFile(writer http.ResponseWriter, request *http.Request) {
	var input deleteFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

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
	if err := server.syncMutationDirectories(filepath.Dir(relative)); err != nil {
		// Removal is already visible. A failed parent sync makes durability
		// unknown; do not recreate the removed entry.
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

type fileRevisionState struct {
	mode     os.FileMode
	revision string
	exists   bool
}

func (server *apiServer) fileRevisionState(relative string) (fileRevisionState, error) {
	file, info, err := server.openRegularFile(relative)
	if errors.Is(err, os.ErrNotExist) {
		return fileRevisionState{revision: missingFileRevision}, nil
	}
	if err != nil {
		return fileRevisionState{}, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil {
		return fileRevisionState{}, err
	}
	if len(content) > maxFileBytes {
		return fileRevisionState{}, errFileTooLarge
	}
	return fileRevisionState{
		mode:     info.Mode(),
		revision: revisionForContent(content),
		exists:   true,
	}, nil
}

func (server *apiServer) openRegularFile(relative string) (*os.File, os.FileInfo, error) {
	file, err := server.workspace.safeRoot.OpenFile(relative, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, errNotRegularFile
	}
	return file, info, nil
}

func revisionForContent(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func isValidExpectedRevision(revision string) bool {
	if revision == missingFileRevision {
		return true
	}
	if len(revision) != fileRevisionLength {
		return false
	}
	for _, character := range []byte(revision) {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func writeRevisionConflict(writer http.ResponseWriter, currentRevision string) {
	writeJSON(writer, http.StatusConflict, revisionConflictResponse{
		Error:           "file revision does not match expectedRevision",
		CurrentRevision: currentRevision,
	})
}

func syncWorkspaceDirectories(workspace workspace, relatives ...string) error {
	return syncWorkspaceDirectoriesWith(workspace, syncWorkspaceDirectory, relatives...)
}

func (server *apiServer) syncMutationDirectories(relatives ...string) error {
	if server.syncDirectories == nil {
		return syncWorkspaceDirectories(server.workspace, relatives...)
	}
	return server.syncDirectories(server.workspace, relatives...)
}

func syncWorkspaceDirectoriesWith(
	workspace workspace,
	syncDirectory func(workspace, string) error,
	relatives ...string,
) error {
	synced := make(map[string]struct{}, len(relatives))
	for _, relative := range relatives {
		current := filepath.Clean(relative)
		if current == "" {
			current = "."
		}
		for {
			if _, found := synced[current]; !found {
				if err := syncDirectory(workspace, current); err != nil {
					return fmt.Errorf("sync workspace directory %q: %w", current, err)
				}
				synced[current] = struct{}{}
			}
			if current == "." {
				break
			}
			parent := filepath.Dir(current)
			if parent == current {
				current = "."
				continue
			}
			current = parent
		}
	}
	return nil
}

func syncWorkspaceDirectory(workspace workspace, relative string) error {
	directory, err := workspace.safeRoot.OpenFile(relative, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return fmt.Errorf("open directory: %w", err)
	}
	info, err := directory.Stat()
	if err != nil {
		_ = directory.Close()
		return fmt.Errorf("stat directory: %w", err)
	}
	if !info.IsDir() {
		_ = directory.Close()
		return errNotDirectory
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return fmt.Errorf("sync directory: %w", err)
	}
	if err := directory.Close(); err != nil {
		return fmt.Errorf("close directory: %w", err)
	}
	return nil
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
	case errors.Is(err, errFileTooLarge):
		writeAPIError(writer, http.StatusRequestEntityTooLarge, errFileTooLarge.Error())
	case errors.Is(err, errNotRegularFile):
		writeAPIError(writer, http.StatusBadRequest, errNotRegularFile.Error())
	case errors.Is(err, errNotDirectory):
		writeAPIError(writer, http.StatusInternalServerError, errNotDirectory.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, "filesystem operation failed")
	}
}

const timeFormat = "2006-01-02T15:04:05.000Z07:00"
