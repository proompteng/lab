package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestFileWatcherRegistersOnlySubscribedDirectoriesAndReleasesThem(t *testing.T) {
	home := t.TempDir()
	nested := filepath.Join(home, "workspace", "src")
	if err := os.MkdirAll(nested, 0o750); err != nil {
		t.Fatalf("create nested directory: %v", err)
	}
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files, err := newFileWatcher(workspace)
	if err != nil {
		t.Fatalf("new watcher: %v", err)
	}
	defer files.close()
	if len(files.watched) != 0 {
		t.Fatalf("watcher eagerly registered %d directories", len(files.watched))
	}

	first, _, err := files.subscribe(0, "/workspace/src", nested)
	if err != nil {
		t.Fatalf("subscribe first: %v", err)
	}
	second, _, err := files.subscribe(0, "/workspace/src", nested)
	if err != nil {
		t.Fatalf("subscribe second: %v", err)
	}
	if len(files.watched) != 1 || files.watched[nested] != 2 {
		t.Fatalf("watch references = %#v, want one directory with two references", files.watched)
	}
	files.unsubscribe(first)
	if files.watched[nested] != 1 {
		t.Fatalf("watch references after first unsubscribe = %d, want 1", files.watched[nested])
	}
	files.unsubscribe(second)
	if len(files.watched) != 0 {
		t.Fatalf("watches after final unsubscribe = %#v, want none", files.watched)
	}
}

func TestFileWatcherReplayIsBoundedAndDoesNotBlock(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	for index := 0; index < fileEventBufferSize; index++ {
		files.publish(fileEvent{Kind: "changed", Path: fmt.Sprintf("/workspace/%04d", index)})
	}
	id, events, err := files.subscribe(0, "/", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)
	for expected := uint64(1); expected <= fileEventBufferSize; expected++ {
		select {
		case event := <-events:
			if event.Sequence != expected {
				t.Fatalf("replayed sequence = %d, want %d", event.Sequence, expected)
			}
		default:
			t.Fatalf("replay stopped before sequence %d", expected)
		}
	}
}

func TestFileWatcherSignalsExpiredCursorAndDisconnectsSlowSubscriber(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	for index := 0; index < fileEventBufferSize+10; index++ {
		files.publish(fileEvent{Kind: "changed", Path: fmt.Sprintf("/workspace/%04d", index)})
	}
	id, events, err := files.subscribe(1, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	reset := <-events
	if reset.Kind != "reset" || reset.Sequence != files.buffer[0].Sequence-1 {
		t.Fatalf("replay reset = %#v", reset)
	}
	files.unsubscribe(id)

	id, events, err = files.subscribe(files.sequence, "/", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	for index := 0; index < 129; index++ {
		files.publish(fileEvent{Kind: "changed", Path: fmt.Sprintf("/workspace/slow-%04d", index)})
	}
	if _, found := files.subscriptions[id]; found {
		t.Fatal("slow file subscriber remained registered after its bounded queue filled")
	}
	for range events {
	}
}

func TestFileWatcherSubscriberLimit(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	ids := make([]uint64, 0, fileSubscriberLimit)
	for range fileSubscriberLimit {
		id, _, err := files.subscribe(0, "/", "")
		if err != nil {
			t.Fatalf("subscribe within limit: %v", err)
		}
		ids = append(ids, id)
	}
	if _, _, err := files.subscribe(0, "/", ""); err == nil {
		t.Fatal("subscriber limit was not enforced")
	}
	for _, id := range ids {
		files.unsubscribe(id)
	}
}
