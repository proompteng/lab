package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	fileEventBufferSize           = 1_024
	defaultFileRenameFenceTimeout = 250 * time.Millisecond
	fileRenameDeferredEventLimit  = 128
	// Keep these limits aligned with the landing desktop's twenty-window,
	// sixteen-directory, and single reconnect-overlap contract.
	fileWatchDirectoryLimit = 20 * 16
	fileSubscriberLimit     = fileWatchDirectoryLimit * 2
)

type fileEvent struct {
	Sequence     uint64     `json:"sequence"`
	Kind         string     `json:"kind"`
	Path         string     `json:"path"`
	PreviousPath string     `json:"previousPath,omitempty"`
	Entry        *fileEntry `json:"entry,omitempty"`

	routingPath         string
	routingPreviousPath string
}

type fileSubscription struct {
	channel   chan fileEvent
	directory string
	prefix    string
}

type expectedFileRename struct {
	generation            uint64
	source                string
	rawSource             string
	rawSourcePath         string
	destination           string
	rawDestination        string
	fenceDirectory        string
	destinationObserved   bool
	rawObserved           bool
	rawEchoPossible       bool
	deferredEvents        []deferredFileEvent
	suppressedSource      bool
	suppressedDestination bool
}

type deferredFileEvent struct {
	event        fileEvent
	absolutePath string
}

type completedFileRename struct {
	generation          uint64
	source              string
	rawSource           string
	destination         string
	rawDestination      string
	fenceDirectory      string
	rawEchoPossible     bool
	rawObserved         bool
	destinationObserved bool
}

type fileWatcher struct {
	workspace        workspace
	watcher          *fsnotify.Watcher
	mu               sync.Mutex
	sequence         uint64
	buffer           []fileEvent
	subscriptions    map[uint64]fileSubscription
	nextSubscriber   uint64
	watched          map[string]uint32
	renameFence      time.Duration
	renameSequence   uint64
	expectedRenames  map[string]expectedFileRename
	completedRenames map[uint64]completedFileRename
	closed           bool
	closeErr         error
	closeOnce        sync.Once
}

func newFileWatcher(workspace workspace) (*fileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	files := &fileWatcher{
		workspace:        workspace,
		watcher:          watcher,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      defaultFileRenameFenceTimeout,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	go files.run()
	return files, nil
}

func (files *fileWatcher) close() error {
	files.closeOnce.Do(func() {
		files.mu.Lock()
		files.closed = true
		for id, subscription := range files.subscriptions {
			delete(files.subscriptions, id)
			close(subscription.channel)
		}
		files.watched = make(map[string]uint32)
		files.expectedRenames = nil
		files.completedRenames = nil
		files.mu.Unlock()
		if files.watcher != nil {
			files.closeErr = files.watcher.Close()
		}
	})
	return files.closeErr
}

func (files *fileWatcher) run() {
	for {
		select {
		case event, ok := <-files.watcher.Events:
			if !ok {
				return
			}
			files.handle(event)
		case err, ok := <-files.watcher.Errors:
			if !ok {
				return
			}
			files.handleWatcherError(err)
		}
	}
}

func (files *fileWatcher) handleWatcherError(err error) {
	if !errors.Is(err, fsnotify.ErrEventOverflow) {
		return
	}
	files.mu.Lock()
	defer files.mu.Unlock()
	for generation, completed := range files.completedRenames {
		files.releaseWatchLocked(completed.fenceDirectory)
		delete(files.completedRenames, generation)
	}
	for source, expected := range files.expectedRenames {
		expected.deferredEvents = nil
		expected.suppressedSource = false
		expected.suppressedDestination = false
		files.expectedRenames[source] = expected
	}
	files.publishResetLocked()
}

func (files *fileWatcher) publishResetLocked() {
	files.sequence++
	reset := fileEvent{Sequence: files.sequence, Kind: "reset", Path: "/"}
	files.buffer = []fileEvent{reset}
	for id, subscription := range files.subscriptions {
		delivery := reset
		delivery.Path = subscription.prefix
		select {
		case subscription.channel <- delivery:
		default:
			files.removeSubscriptionLocked(id)
		}
	}
}

func (files *fileWatcher) publishScopedResetLocked(path string) {
	files.sequence++
	reset := fileEvent{Sequence: files.sequence, Kind: "reset", Path: path}
	files.buffer = append(files.buffer, reset)
	if len(files.buffer) > fileEventBufferSize {
		files.buffer = files.buffer[len(files.buffer)-fileEventBufferSize:]
	}
	for id, subscription := range files.subscriptions {
		if !fileEventMatchesPrefix(reset, subscription.prefix) {
			continue
		}
		delivery := reset
		delivery.Path = subscription.prefix
		select {
		case subscription.channel <- delivery:
		default:
			files.removeSubscriptionLocked(id)
		}
	}
}

func (files *fileWatcher) handle(event fsnotify.Event) {
	if !files.workspace.isVisibleAbsolute(event.Name) {
		return
	}
	kind := "changed"
	switch {
	case event.Has(fsnotify.Create):
		kind = "created"
	case event.Has(fsnotify.Remove):
		kind = "removed"
	case event.Has(fsnotify.Rename):
		files.handleRawRename(event.Name)
		return
	case event.Has(fsnotify.Write), event.Has(fsnotify.Chmod):
		kind = "changed"
	default:
		return
	}
	display := files.workspace.displayPath(event.Name)
	var entry *fileEntry
	if kind != "removed" && kind != "renamed" {
		if info, err := os.Stat(event.Name); err == nil {
			entry = &fileEntry{
				Name:       filepath.Base(event.Name),
				Path:       display,
				Directory:  info.IsDir(),
				Size:       info.Size(),
				ModifiedAt: info.ModTime().UTC().Format(timeFormat),
			}
		}
	}
	fileEvent := fileEvent{Kind: kind, Path: display, Entry: entry}
	if files.suppressRawEvent(fileEvent, event.Name) {
		return
	}
	files.publish(fileEvent)
	if kind == "removed" {
		files.invalidateDirectory(event.Name)
	}
}

func (files *fileWatcher) publish(event fileEvent) {
	files.mu.Lock()
	defer files.mu.Unlock()
	files.publishLocked(event)
}

func (files *fileWatcher) publishLocked(event fileEvent) {
	files.sequence++
	event.Sequence = files.sequence
	files.buffer = append(files.buffer, event)
	if len(files.buffer) > fileEventBufferSize {
		files.buffer = files.buffer[len(files.buffer)-fileEventBufferSize:]
	}
	for id, subscription := range files.subscriptions {
		if !fileEventMatchesPrefix(event, subscription.prefix) {
			continue
		}
		select {
		case subscription.channel <- event:
		default:
			files.removeSubscriptionLocked(id)
		}
	}
}

func (files *fileWatcher) handleRawRename(source string) {
	display := files.workspace.displayPath(source)
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.closed {
		return
	}
	if generation, completed, found := files.oldestCompletedRenameSourceLocked(display, false); found {
		completed.rawObserved = true
		files.completedRenames[generation] = completed
		files.finishCompletedRenameLocked(generation, completed)
		return
	}
	for source, expected := range files.expectedRenames {
		if display == expected.rawSourcePath {
			if expected.destinationObserved && expected.hasDeferredSourceGeneration() {
				expected.suppressedSource = true
				files.deferExpectedEventLocked(&expected, deferredFileEvent{
					event:        fileEvent{Kind: "reset", Path: display},
					absolutePath: source,
				})
				files.expectedRenames[source] = expected
				return
			}
			expected.rawObserved = true
			files.expectedRenames[source] = expected
			return
		}
	}
	if _, _, found := files.oldestCompletedRenameSourceLocked(display, true); found {
		// A completed generation can remain until its destination Create fence.
		// Suppress duplicate source echoes without consuming a newer operation.
		return
	}
	// A raw fsnotify rename contains only the vanished source path. Publishing a
	// removal would make an atomic replacement look like data loss before the
	// following Create arrives. Reset subscribers instead so they reconcile the
	// authoritative filesystem state without inventing a destination.
	files.publishScopedResetLocked(display)
	files.invalidateDirectoryLocked(source)
}

func (expected expectedFileRename) hasDeferredSourceGeneration() bool {
	for _, deferred := range expected.deferredEvents {
		if deferred.event.Path == expected.rawSourcePath && deferred.event.Kind == "created" {
			return true
		}
	}
	return false
}

func (files *fileWatcher) suppressRawEvent(event fileEvent, absolutePath string) bool {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.closed {
		return true
	}
	if event.Kind == "created" {
		if generation, completed, found := files.oldestCompletedRenameDestinationLocked(event.Path, false); found {
			completed.destinationObserved = true
			files.completedRenames[generation] = completed
			files.finishCompletedRenameLocked(generation, completed)
			return true
		}
	}
	for source, expected := range files.expectedRenames {
		if event.Path == expected.rawSourcePath || event.Path == expected.rawDestination {
			if event.Path == expected.rawSourcePath {
				expected.suppressedSource = true
			} else {
				expected.suppressedDestination = true
			}
			if event.Kind == "created" && event.Path == expected.rawDestination && !expected.destinationObserved {
				expected.destinationObserved = true
				files.expectedRenames[source] = expected
				return true
			}
			if expected.destinationObserved {
				files.deferExpectedEventLocked(&expected, deferredFileEvent{event: event, absolutePath: absolutePath})
			}
			files.expectedRenames[source] = expected
			return true
		}
	}
	if event.Kind == "created" {
		// A Create at a completed source is a new filesystem generation. Kernel
		// events for one watch are ordered, so any older unobserved source echo was
		// lost and must not consume a later rename of the recreated entry.
		files.retireCompletedRenameSourcesLocked(event.Path)
	}
	return false
}

func (files *fileWatcher) deferExpectedEventLocked(expected *expectedFileRename, deferred deferredFileEvent) {
	if len(expected.deferredEvents) == 1 &&
		expected.deferredEvents[0].event.Kind == "reset" &&
		expected.deferredEvents[0].event.Path == "/" {
		return
	}
	if len(expected.deferredEvents) >= fileRenameDeferredEventLimit {
		expected.deferredEvents = []deferredFileEvent{{event: fileEvent{Kind: "reset", Path: "/"}}}
		return
	}
	expected.deferredEvents = append(expected.deferredEvents, deferred)
}

func (files *fileWatcher) retireCompletedRenameSourcesLocked(source string) {
	for generation, completed := range files.completedRenames {
		if completed.rawSource != source {
			continue
		}
		delete(files.completedRenames, generation)
		files.releaseWatchLocked(completed.fenceDirectory)
	}
}

func (files *fileWatcher) beginPairedRename(source string, destination string) (uint64, error) {
	return files.beginPairedRenamePaths(source, source, destination, destination)
}

func (files *fileWatcher) beginPairedRenamePaths(
	source string,
	rawSource string,
	destination string,
	rawDestination string,
) (uint64, error) {
	display := files.workspace.displayPath(source)
	rawSourceDisplay := files.workspace.displayPath(rawSource)
	destinationDisplay := files.workspace.displayPath(destination)
	rawDestinationDisplay := files.workspace.displayPath(rawDestination)
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.closed {
		return 0, errors.New("filesystem event service is shutting down")
	}
	if files.expectedRenames == nil {
		files.expectedRenames = make(map[string]expectedFileRename)
	}
	if _, found := files.expectedRenames[display]; found {
		return 0, errors.New("rename already in progress")
	}
	for expectedSource, expected := range files.expectedRenames {
		logicalConflict := display == expectedSource ||
			display == expected.destination ||
			destinationDisplay == expectedSource ||
			expected.destination == destinationDisplay
		rawConflict := rawSourceDisplay == expected.rawSourcePath ||
			rawSourceDisplay == expected.rawDestination ||
			rawDestinationDisplay == expected.rawSourcePath ||
			expected.rawDestination == rawDestinationDisplay
		if logicalConflict || rawConflict {
			return 0, errors.New("destination rename already in progress")
		}
	}
	rawEchoPossible := files.rawRenameMayArriveLocked(rawSource)
	fenceDirectory := filepath.Dir(rawDestination)
	if err := files.acquireWatchLocked(fenceDirectory); err != nil {
		// The destination watch only provides an ordered fence for suppressing
		// fsnotify echoes. A platform or process watch limit must not prevent the
		// underlying filesystem mutation; fall back to bounded source-echo
		// suppression when the source is already watched.
		fenceDirectory = ""
	}
	files.renameSequence++
	generation := files.renameSequence
	files.expectedRenames[display] = expectedFileRename{
		generation:      generation,
		source:          source,
		rawSource:       rawSource,
		rawSourcePath:   rawSourceDisplay,
		destination:     destinationDisplay,
		rawDestination:  rawDestinationDisplay,
		fenceDirectory:  fenceDirectory,
		rawEchoPossible: rawEchoPossible,
	}
	return generation, nil
}

func (files *fileWatcher) cancelPairedRename(source string, generation uint64) {
	display := files.workspace.displayPath(source)
	files.mu.Lock()
	defer files.mu.Unlock()
	if expected, found := files.expectedRenames[display]; found && expected.generation == generation {
		delete(files.expectedRenames, display)
		files.releaseWatchLocked(expected.fenceDirectory)
		sourceReconciled := false
		if expected.rawObserved {
			if _, err := os.Lstat(expected.source); !expected.destinationObserved && errors.Is(err, os.ErrNotExist) {
				files.publishLocked(fileEvent{Kind: "removed", Path: display})
				files.invalidateDirectoryLocked(expected.rawSource)
			} else {
				files.publishScopedResetLocked(expected.rawSourcePath)
			}
			sourceReconciled = true
		}
		if expected.suppressedSource && !sourceReconciled {
			files.publishScopedResetLocked(expected.rawSourcePath)
		}
		if expected.suppressedDestination && expected.rawDestination != expected.rawSourcePath {
			files.publishScopedResetLocked(expected.rawDestination)
		}
	}
}

func (files *fileWatcher) publishPairedRename(source string, generation uint64, event fileEvent) {
	display := files.workspace.displayPath(source)
	files.mu.Lock()
	defer files.mu.Unlock()
	event.Kind = "renamed"
	event.PreviousPath = display
	expected, found := files.expectedRenames[display]
	if found && expected.generation == generation {
		delete(files.expectedRenames, display)
		event.routingPath = expected.rawDestination
		event.routingPreviousPath = expected.rawSourcePath
		files.rememberCompletedRenameLocked(completedFileRename{
			generation:          generation,
			source:              display,
			rawSource:           expected.rawSourcePath,
			destination:         expected.destination,
			rawDestination:      expected.rawDestination,
			fenceDirectory:      expected.fenceDirectory,
			rawEchoPossible:     expected.rawEchoPossible || files.rawRenameMayArriveLocked(expected.rawSource),
			rawObserved:         expected.rawObserved,
			destinationObserved: expected.destinationObserved,
		})
	}
	files.publishLocked(event)
	if found && expected.generation == generation {
		files.invalidateDirectoryLocked(expected.rawSource)
		for _, deferred := range expected.deferredEvents {
			if deferred.event.Kind == "reset" {
				if deferred.event.Path == "/" {
					files.publishResetLocked()
				} else {
					files.publishScopedResetLocked(deferred.event.Path)
				}
				continue
			}
			if deferred.event.Kind == "created" {
				files.retireCompletedRenameSourcesLocked(deferred.event.Path)
			}
			files.publishLocked(deferred.event)
			if deferred.event.Kind == "removed" {
				files.invalidateDirectoryLocked(deferred.absolutePath)
			}
		}
	}
}

func (files *fileWatcher) rawRenameMayArriveLocked(source string) bool {
	if files.watcher == nil {
		return true
	}
	return files.watched[source] > 0 || files.watched[filepath.Dir(source)] > 0
}

func (files *fileWatcher) rememberCompletedRenameLocked(completed completedFileRename) {
	if files.completedRenames == nil {
		files.completedRenames = make(map[uint64]completedFileRename)
	}
	files.completedRenames[completed.generation] = completed
	if files.finishCompletedRenameLocked(completed.generation, completed) {
		return
	}
	time.AfterFunc(files.renameFenceTimeout(), func() {
		files.expireCompletedRename(completed.generation)
	})
}

func (files *fileWatcher) finishCompletedRenameLocked(generation uint64, completed completedFileRename) bool {
	if completed.rawEchoPossible && !completed.rawObserved {
		return false
	}
	if completed.fenceDirectory != "" && !completed.destinationObserved {
		return false
	}
	delete(files.completedRenames, generation)
	files.releaseWatchLocked(completed.fenceDirectory)
	return true
}

func (files *fileWatcher) oldestCompletedRenameSourceLocked(
	path string,
	observed bool,
) (uint64, completedFileRename, bool) {
	return files.oldestCompletedRenameLocked(func(completed completedFileRename) bool {
		return completed.rawSource == path && completed.rawObserved == observed
	})
}

func (files *fileWatcher) oldestCompletedRenameDestinationLocked(
	path string,
	observed bool,
) (uint64, completedFileRename, bool) {
	return files.oldestCompletedRenameLocked(func(completed completedFileRename) bool {
		return completed.rawDestination == path && completed.destinationObserved == observed
	})
}

func (files *fileWatcher) oldestCompletedRenameLocked(
	matches func(completedFileRename) bool,
) (uint64, completedFileRename, bool) {
	var selected completedFileRename
	found := false
	for _, completed := range files.completedRenames {
		if !matches(completed) || found && completed.generation >= selected.generation {
			continue
		}
		selected = completed
		found = true
	}
	return selected.generation, selected, found
}

func (files *fileWatcher) expireCompletedRename(generation uint64) {
	files.mu.Lock()
	defer files.mu.Unlock()
	completed, found := files.completedRenames[generation]
	if !found {
		return
	}
	delete(files.completedRenames, generation)
	files.releaseWatchLocked(completed.fenceDirectory)
}

func (files *fileWatcher) renameFenceTimeout() time.Duration {
	if files.renameFence > 0 {
		return files.renameFence
	}
	return defaultFileRenameFenceTimeout
}

func (files *fileWatcher) subscribe(after uint64, prefix string, directory string) (uint64, <-chan fileEvent, error) {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.closed {
		return 0, nil, errors.New("filesystem event service is shutting down")
	}
	if len(files.subscriptions) >= fileSubscriberLimit {
		return 0, nil, errors.New("too many filesystem event subscribers")
	}
	if err := files.acquireWatchLocked(directory); err != nil {
		return 0, nil, err
	}
	files.nextSubscriber++
	id := files.nextSubscriber
	replay := make([]fileEvent, 0, len(files.buffer)+1)
	bufferStart := uint64(0)
	if len(files.buffer) > 0 {
		bufferStart = files.buffer[0].Sequence
	}
	replayStart := sequenceBefore(bufferStart)
	if after > files.sequence || (len(files.buffer) > 0 && after > 0 && after < replayStart) {
		replay = append(replay, fileEvent{Sequence: replayStart, Kind: "reset", Path: prefix})
		after = 0
	} else {
		for _, event := range files.buffer {
			if event.Sequence <= after {
				continue
			}
			if !fileEventMatchesPrefix(event, prefix) {
				continue
			}
			if event.Kind == "reset" {
				event.Path = prefix
				replay = append(replay, event)
				continue
			}
			replay = append(replay, event)
		}
	}
	channel := make(chan fileEvent, len(replay)+128)
	for _, event := range replay {
		channel <- event
	}
	files.subscriptions[id] = fileSubscription{channel: channel, directory: directory, prefix: prefix}
	return id, channel, nil
}

func (files *fileWatcher) unsubscribe(id uint64) {
	files.mu.Lock()
	defer files.mu.Unlock()
	files.removeSubscriptionLocked(id)
}

func (files *fileWatcher) acquireWatchLocked(directory string) error {
	if files.watcher == nil || directory == "" {
		return nil
	}
	if references := files.watched[directory]; references > 0 {
		files.watched[directory] = references + 1
		return nil
	}
	if len(files.watched) >= fileWatchDirectoryLimit {
		return errors.New("too many filesystem directories are being watched")
	}
	if err := files.watcher.Add(directory); err != nil {
		return err
	}
	files.watched[directory] = 1
	return nil
}

func (files *fileWatcher) removeSubscriptionLocked(id uint64) {
	subscription, ok := files.subscriptions[id]
	if !ok {
		return
	}
	delete(files.subscriptions, id)
	close(subscription.channel)
	files.releaseWatchLocked(subscription.directory)
}

func (files *fileWatcher) releaseWatchLocked(directory string) {
	if files.watcher == nil || directory == "" {
		return
	}
	references := files.watched[directory]
	if references > 1 {
		files.watched[directory] = references - 1
		return
	}
	delete(files.watched, directory)
	_ = files.watcher.Remove(directory)
}

func (files *fileWatcher) invalidateDirectory(directory string) {
	files.mu.Lock()
	defer files.mu.Unlock()
	files.invalidateDirectoryLocked(directory)
}

func (files *fileWatcher) invalidateDirectoryLocked(directory string) {
	if _, watched := files.watched[directory]; !watched {
		return
	}
	for id, subscription := range files.subscriptions {
		if subscription.directory == directory {
			delete(files.subscriptions, id)
			close(subscription.channel)
		}
	}
	delete(files.watched, directory)
}

func (server *apiServer) handleWatchFiles(writer http.ResponseWriter, request *http.Request) {
	target, err := server.workspace.resolveExisting(request.URL.Query().Get("path"))
	if err != nil {
		writeWorkspaceError(writer, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		writeAPIError(writer, http.StatusBadRequest, "watch path must be a directory")
		return
	}
	after := uint64(0)
	if raw := request.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, "after must be an unsigned sequence")
			return
		}
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeAPIError(writer, http.StatusInternalServerError, "streaming is unavailable")
		return
	}
	id, events, err := server.fileWatcher.subscribe(after, server.workspace.displayPath(target), target)
	if err != nil {
		writeAPIError(writer, http.StatusTooManyRequests, err.Error())
		return
	}
	defer server.fileWatcher.unsubscribe(id)
	writer.Header().Set("Content-Type", "application/x-ndjson")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(http.StatusOK)
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	encoder := json.NewEncoder(writer)
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			if err := encoder.Encode(event); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := writer.Write([]byte("\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func fileEventMatchesPrefix(event fileEvent, prefix string) bool {
	if event.Kind == "reset" {
		return event.Path == "/" || pathWithin(prefix, event.Path) || pathWithin(event.Path, prefix)
	}
	if pathMatchesWatchPrefix(prefix, event.Path) || pathMatchesWatchPrefix(prefix, event.routingPath) {
		return true
	}
	return event.Kind == "renamed" &&
		(pathMatchesWatchPrefix(prefix, event.PreviousPath) ||
			pathMatchesWatchPrefix(prefix, event.routingPreviousPath))
}

func pathMatchesWatchPrefix(prefix string, path string) bool {
	return path != "" && (prefix == "/" || pathWithin(prefix, path))
}

func parseBoundedInt(value string, minimum, maximum int) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, errors.New("value outside allowed range")
	}
	return parsed, nil
}
