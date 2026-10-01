package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

type fileWriteInput struct {
	Path             string
	Content          []byte
	ExpectedRevision string
}
type operationError struct {
	status          int
	message         string
	currentRevision string
}

func (err *operationError) Error() string { return err.message }

func (server *apiServer) listFiles(requested string) (fileList, error) {
	if _, err := server.workspace.resolveExisting(requested); err != nil {
		return fileList{}, err
	}
	relative, err := server.workspace.relative(requested)
	if err != nil {
		return fileList{}, err
	}
	directory, err := server.workspace.safeRoot.Open(relative)
	if err != nil {
		return fileList{}, err
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		return fileList{}, err
	}
	if !info.IsDir() {
		return fileList{}, &operationError{status: http.StatusBadRequest, message: "path is not a directory"}
	}
	entries, err := readDirectoryEntries(directory, maxDirectoryEntries)
	if err != nil {
		if errors.Is(err, errTooManyDirectoryEntries) {
			return fileList{}, &operationError{status: http.StatusRequestEntityTooLarge, message: err.Error()}
		}
		return fileList{}, err
	}
	result := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		item, itemErr := server.fileEntryRelative(filepath.Join(relative, entry.Name()))
		if itemErr == nil {
			result = append(result, item)
		}
	}
	sortFileEntries(result)
	return fileList{Path: server.workspace.displayRelative(relative), Entries: result}, nil
}

func (server *apiServer) writeFile(input fileWriteInput) (writeFileResponse, error) {
	if !isValidExpectedRevision(input.ExpectedRevision) {
		return writeFileResponse{}, &operationError{status: http.StatusBadRequest, message: "expectedRevision must be a lowercase SHA256 or missing"}
	}
	content := input.Content
	if len(content) > maxFileBytes {
		return writeFileResponse{}, &operationError{status: http.StatusRequestEntityTooLarge, message: errFileTooLarge.Error()}
	}

	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()
	// This lock serializes Nanoagent API writers. Direct filesystem writers
	// outside this process are not participants in the check-and-rename
	// protocol, so expectedRevision remains a content snapshot for them.

	target, err := server.workspace.resolveForWrite(input.Path)
	if err != nil {
		return writeFileResponse{}, err
	}
	if target == server.workspace.root {
		return writeFileResponse{}, &operationError{status: http.StatusBadRequest, message: "cannot overwrite the home root"}
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		return writeFileResponse{}, err
	}
	state, err := server.fileRevisionState(relative)
	if err != nil {
		return writeFileResponse{}, err
	}
	if state.revision != input.ExpectedRevision {
		return writeFileResponse{}, &operationError{status: http.StatusConflict, message: "file revision changed", currentRevision: state.revision}
	}
	parent := filepath.Dir(relative)
	if err := server.workspace.safeRoot.MkdirAll(parent, 0o750); err != nil {
		return writeFileResponse{}, err
	}
	mode := os.FileMode(0o640)
	if state.exists {
		mode = state.mode.Perm()
	}
	temporaryName, temporary, err := createWorkspaceTemporaryFile(server.workspace, parent, mode)
	if err != nil {
		return writeFileResponse{}, err
	}
	defer server.workspace.safeRoot.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return writeFileResponse{}, err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return writeFileResponse{}, err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return writeFileResponse{}, err
	}
	if err := temporary.Close(); err != nil {
		return writeFileResponse{}, err
	}
	if err := server.workspace.safeRoot.Rename(temporaryName, relative); err != nil {
		return writeFileResponse{}, err
	}
	if err := server.syncMutationDirectories(parent); err != nil {
		// Rename has already made the new content visible. A failed parent sync
		// makes durability unknown; do not remove or otherwise roll back it.
		return writeFileResponse{}, err
	}
	return writeFileResponse{
		Path:     server.workspace.displayRelative(relative),
		Size:     int64(len(content)),
		Revision: revisionForContent(content),
	}, nil
}

func (server *apiServer) createDirectory(input pathRequest) (fileEntry, error) {
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

	target, err := server.workspace.resolveForWrite(input.Path)
	if err != nil {
		return fileEntry{}, err
	}
	if target == server.workspace.root {
		return fileEntry{}, &operationError{status: http.StatusConflict, message: "home root already exists"}
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		return fileEntry{}, err
	}
	if _, err := server.workspace.safeRoot.Lstat(relative); err == nil {
		return fileEntry{}, &operationError{status: http.StatusConflict, message: "path already exists"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fileEntry{}, err
	}
	if err := server.workspace.safeRoot.MkdirAll(relative, 0o750); err != nil {
		return fileEntry{}, err
	}
	if err := server.syncMutationDirectories(relative); err != nil {
		// The directory is already visible. A failed sync leaves its durable
		// acknowledgement unknown, so leave the mutation in place.
		return fileEntry{}, err
	}
	entry, err := server.fileEntryRelative(relative)
	if err != nil {
		return fileEntry{}, err
	}
	return entry, nil
}

func (server *apiServer) moveFile(input moveFileRequest) (fileEntry, error) {
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

	source, err := server.workspace.resolveExisting(input.SourcePath)
	if err != nil {
		return fileEntry{}, err
	}
	if source == server.workspace.realRoot {
		return fileEntry{}, &operationError{status: http.StatusBadRequest, message: "cannot move the home root"}
	}
	sourceRelative, err := server.workspace.relative(input.SourcePath)
	if err != nil {
		return fileEntry{}, err
	}
	logicalSource := filepath.Join(server.workspace.realRoot, sourceRelative)
	sourceInfo, err := server.workspace.safeRoot.Lstat(sourceRelative)
	if err != nil {
		return fileEntry{}, err
	}
	rawSource := source
	if sourceInfo.Mode()&os.ModeSymlink != 0 {
		// Rename moves a leaf symlink entry rather than its target, but fsnotify
		// still reports that entry beneath the canonical parent directory.
		rawSourceParent, err := filepath.EvalSymlinks(filepath.Dir(logicalSource))
		if err != nil {
			return fileEntry{}, err
		}
		rawSource = filepath.Join(rawSourceParent, filepath.Base(logicalSource))
	}
	destination, err := server.workspace.resolveForWrite(input.DestinationPath)
	if err != nil {
		return fileEntry{}, err
	}
	if destination == server.workspace.root {
		return fileEntry{}, &operationError{status: http.StatusBadRequest, message: "cannot replace the home root"}
	}
	destinationRelative, err := server.workspace.relative(input.DestinationPath)
	if err != nil {
		return fileEntry{}, err
	}
	if _, err := server.workspace.safeRoot.Lstat(destinationRelative); err == nil {
		return fileEntry{}, &operationError{status: http.StatusConflict, message: "destination already exists"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fileEntry{}, err
	}
	if err := server.workspace.safeRoot.MkdirAll(filepath.Dir(destinationRelative), 0o750); err != nil {
		return fileEntry{}, err
	}
	logicalDestination := filepath.Join(server.workspace.realRoot, destinationRelative)
	rawDestinationParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return fileEntry{}, err
	}
	rawDestination := filepath.Join(rawDestinationParent, filepath.Base(destination))
	renameGeneration, err := server.fileWatcher.beginPairedRenamePaths(
		logicalSource,
		rawSource,
		logicalDestination,
		rawDestination,
	)
	if err != nil {
		return fileEntry{}, &operationError{status: http.StatusConflict, message: err.Error()}
	}
	renamePublished := false
	defer func() {
		if !renamePublished {
			server.fileWatcher.cancelPairedRename(logicalSource, renameGeneration)
		}
	}()
	if err := server.workspace.safeRoot.Rename(sourceRelative, destinationRelative); err != nil {
		return fileEntry{}, err
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
		return fileEntry{}, syncErr
	}
	if err != nil {
		return fileEntry{}, err
	}
	return entry, nil
}

func (server *apiServer) deleteFile(input deleteFileRequest) (struct{}, error) {
	server.fileMutationMu.Lock()
	defer server.fileMutationMu.Unlock()

	target, err := server.workspace.resolveExisting(input.Path)
	if err != nil {
		return struct{}{}, err
	}
	if target == server.workspace.realRoot {
		return struct{}{}, &operationError{status: http.StatusBadRequest, message: "cannot delete the home root"}
	}
	relative, err := server.workspace.relative(input.Path)
	if err != nil {
		return struct{}{}, err
	}
	info, err := server.workspace.safeRoot.Lstat(relative)
	if err != nil {
		return struct{}{}, err
	}
	if info.IsDir() && input.Recursive {
		err = server.workspace.safeRoot.RemoveAll(relative)
	} else {
		err = server.workspace.safeRoot.Remove(relative)
	}
	if err != nil {
		if info.IsDir() && !input.Recursive {
			return struct{}{}, &operationError{status: http.StatusConflict, message: "directory is not empty; recursive deletion was not authorized"}
		}
		return struct{}{}, err
	}
	if err := server.syncMutationDirectories(filepath.Dir(relative)); err != nil {
		// Removal is already visible. A failed parent sync makes durability
		// unknown; do not recreate the removed entry.
		return struct{}{}, err
	}
	return struct{}{}, nil
}
