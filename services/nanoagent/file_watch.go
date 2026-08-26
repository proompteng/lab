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
	fileEventBufferSize     = 1_024
	fileSubscriberLimit     = 16
	fileWatchDirectoryLimit = 32
)

type fileEvent struct {
	Sequence     uint64     `json:"sequence"`
	Kind         string     `json:"kind"`
	Path         string     `json:"path"`
	PreviousPath string     `json:"previousPath,omitempty"`
	Entry        *fileEntry `json:"entry,omitempty"`
}

type fileSubscription struct {
	channel   chan fileEvent
	directory string
	prefix    string
}

type fileWatcher struct {
	workspace      workspace
	watcher        *fsnotify.Watcher
	mu             sync.Mutex
	sequence       uint64
	buffer         []fileEvent
	subscriptions  map[uint64]fileSubscription
	nextSubscriber uint64
	watched        map[string]uint32
	closed         bool
	closeErr       error
	closeOnce      sync.Once
}

func newFileWatcher(workspace workspace) (*fileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	files := &fileWatcher{
		workspace:     workspace,
		watcher:       watcher,
		subscriptions: make(map[uint64]fileSubscription),
		watched:       make(map[string]uint32),
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
		case _, ok := <-files.watcher.Errors:
			if !ok {
				return
			}
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
		kind = "renamed"
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
	files.publish(fileEvent{Kind: kind, Path: display, Entry: entry})
	if kind == "removed" || kind == "renamed" {
		files.invalidateDirectory(event.Name)
	}
}

func (files *fileWatcher) publish(event fileEvent) {
	files.mu.Lock()
	defer files.mu.Unlock()
	files.sequence++
	event.Sequence = files.sequence
	files.buffer = append(files.buffer, event)
	if len(files.buffer) > fileEventBufferSize {
		files.buffer = files.buffer[len(files.buffer)-fileEventBufferSize:]
	}
	for id, subscription := range files.subscriptions {
		if !pathWithin(subscription.prefix, event.Path) && subscription.prefix != "/" {
			continue
		}
		select {
		case subscription.channel <- event:
		default:
			files.removeSubscriptionLocked(id)
		}
	}
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
	if len(files.buffer) > 0 && (after > files.sequence || (after > 0 && after < replayStart)) {
		replay = append(replay, fileEvent{Sequence: replayStart, Kind: "reset", Path: prefix})
		after = 0
	} else {
		for _, event := range files.buffer {
			if event.Sequence > after && (prefix == "/" || pathWithin(prefix, event.Path)) {
				replay = append(replay, event)
			}
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

func parseBoundedInt(value string, minimum, maximum int) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, errors.New("value outside allowed range")
	}
	return parsed, nil
}
