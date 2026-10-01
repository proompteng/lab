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
	result, err := server.listFiles(request.URL.Query().Get("path"))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
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
	result, err := server.writeFile(fileWriteInput{Path: input.Path, Content: content, ExpectedRevision: input.ExpectedRevision})
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (server *apiServer) handleCreateDirectory(writer http.ResponseWriter, request *http.Request) {
	var input pathRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	result, err := server.createDirectory(input)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, result)
}

func (server *apiServer) handleMoveFile(writer http.ResponseWriter, request *http.Request) {
	var input moveFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	result, err := server.moveFile(input)
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (server *apiServer) handleDeleteFile(writer http.ResponseWriter, request *http.Request) {
	var input deleteFileRequest
	if !decodeJSON(writer, request, &input) {
		return
	}
	_, err := server.deleteFile(input)
	if err != nil {
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
	failure := workspaceFailure(err)
	if failure.currentRevision != "" {
		writeRevisionConflict(writer, failure.currentRevision)
		return
	}
	writeAPIError(writer, failure.status, failure.message)
}

func workspaceFailure(err error) *operationError {
	var operation *operationError
	if errors.As(err, &operation) {
		return operation
	}
	switch {
	case errors.Is(err, errInternalPath):
		return &operationError{status: http.StatusNotFound, message: "path is not visible"}
	case errors.Is(err, errPathOutsideWorkspace):
		return &operationError{status: http.StatusForbidden, message: "path must remain inside the user home"}
	case errors.Is(err, os.ErrNotExist):
		return &operationError{status: http.StatusNotFound, message: "path does not exist"}
	case errors.Is(err, os.ErrPermission):
		return &operationError{status: http.StatusForbidden, message: "path is not accessible"}
	case errors.Is(err, errFileTooLarge):
		return &operationError{status: http.StatusRequestEntityTooLarge, message: errFileTooLarge.Error()}
	case errors.Is(err, errNotRegularFile):
		return &operationError{status: http.StatusBadRequest, message: errNotRegularFile.Error()}
	case errors.Is(err, errNotDirectory):
		return &operationError{status: http.StatusInternalServerError, message: errNotDirectory.Error()}
	default:
		return &operationError{status: http.StatusInternalServerError, message: "filesystem operation failed"}
	}
}

const timeFormat = "2006-01-02T15:04:05.000Z07:00"
