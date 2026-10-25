package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestFileWatcherSignalsResetAfterKernelQueueOverflow(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	files.publish(fileEvent{Kind: "changed", Path: "/workspace/before-overflow"})
	<-events
	files.handleWatcherError(fsnotify.ErrEventOverflow)
	reset := <-events
	if reset.Kind != "reset" || reset.Path != "/workspace" {
		t.Fatalf("overflow event = %#v, want reset for /workspace", reset)
	}

	replayID, replay, err := files.subscribe(reset.Sequence-1, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe after overflow: %v", err)
	}
	defer files.unsubscribe(replayID)
	if replayed := <-replay; replayed.Kind != "reset" || replayed.Path != "/workspace" {
		t.Fatalf("overflow replay = %#v, want reset for /workspace", replayed)
	}

	files.handleWatcherError(errors.New("unrelated watcher error"))
	select {
	case event := <-events:
		t.Fatalf("unrelated error emitted %#v", event)
	default:
	}
}

func TestFileWatcherClearsCompletedRenameEchoesAfterKernelQueueOverflow(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if paired := <-events; paired.Kind != "renamed" {
		t.Fatalf("paired event = %#v, want renamed", paired)
	}

	files.handleWatcherError(fsnotify.ErrEventOverflow)
	if reset := <-events; reset.Kind != "reset" {
		t.Fatalf("overflow event = %#v, want reset", reset)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	select {
	case reset := <-events:
		if reset.Kind != "reset" || reset.Path != "/workspace" {
			t.Fatalf("post-overflow raw rename = %#v, want reconciliation reset", reset)
		}
	case <-time.After(time.Second):
		t.Fatal("stale completed rename marker suppressed a post-overflow raw rename")
	}
}

func TestFileWatcherRetainsInFlightRenameEchoSuppressionAcrossKernelQueueOverflow(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handleWatcherError(fsnotify.ErrEventOverflow)
	if reset := <-events; reset.Kind != "reset" {
		t.Fatalf("overflow event = %#v, want reset", reset)
	}

	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if paired := <-events; paired.Kind != "renamed" || paired.PreviousPath != "/workspace/source.txt" {
		t.Fatalf("paired event = %#v, want authoritative rename", paired)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	select {
	case extra := <-events:
		t.Fatalf("post-overflow API rename emitted an extra event: %#v", extra)
	default:
	}
}

func TestFileWatcherDiscardsStaleEventsAfterDeferredRenameOverflow(t *testing.T) {
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, workspacePath, "")
	if err != nil {
		t.Fatal(err)
	}
	defer files.unsubscribe(id)
	files.publish(fileEvent{Kind: "modified", Path: "/workspace/obsolete.txt"})
	<-events
	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatal(err)
	}
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	for range fileRenameDeferredEventLimit + 2 {
		files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Write})
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if renamed := <-events; renamed.Kind != "renamed" {
		t.Fatalf("missing authoritative rename: %#v", renamed)
	}
	if reset := <-events; reset.Kind != "reset" || reset.Path != workspacePath {
		t.Fatalf("missing canonical reset: %#v", reset)
	}
	select {
	case stale := <-events:
		t.Fatalf("deferred event escaped after the reconciliation reset: %#v", stale)
	default:
	}
	replayID, replay, err := files.subscribe(0, workspacePath, "")
	if err != nil {
		t.Fatal(err)
	}
	defer files.unsubscribe(replayID)
	if reset := <-replay; reset.Kind != "reset" || reset.Path != workspacePath {
		t.Fatalf("obsolete history survived the reset: %#v", reset)
	}
	select {
	case stale := <-replay:
		t.Fatalf("obsolete event remained in replay history: %#v", stale)
	default:
	}
}

func TestFileWatcherDiscardsDeferredEventsAfterKernelQueueOverflow(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Remove})
	files.handleWatcherError(fsnotify.ErrEventOverflow)
	if reset := <-events; reset.Kind != "reset" {
		t.Fatalf("overflow event = %#v, want reset", reset)
	}

	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if paired := <-events; paired.Kind != "renamed" || paired.Path != "/workspace/destination.txt" {
		t.Fatalf("paired event = %#v, want authoritative rename", paired)
	}
	select {
	case stale := <-events:
		t.Fatalf("pre-overflow deferred event escaped after reset: %#v", stale)
	default:
	}
}

func TestFileWatcherRepresentsRawRenameAsReconciliationReset(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:     workspace,
		subscriptions: make(map[uint64]fileSubscription),
		watched:       make(map[string]uint32),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	files.handle(fsnotify.Event{Name: filepath.Join(workspace.realRoot, "old-name.txt"), Op: fsnotify.Rename})
	select {
	case event := <-events:
		if event.Kind != "reset" || event.Path != "/workspace" || event.PreviousPath != "" || event.Entry != nil {
			t.Fatalf("raw rename event = %#v, want reconciliation reset", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for reconciliation reset")
	}
}

func TestFileWatcherReconcilesRapidExternalRenameAndRecreation(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:     workspace,
		subscriptions: make(map[uint64]fileSubscription),
		watched:       make(map[string]uint32),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	if err := os.WriteFile(source, []byte("replacement"), 0o600); err != nil {
		t.Fatalf("recreate source: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})

	if reset := <-events; reset.Kind != "reset" || reset.Path != "/workspace" {
		t.Fatalf("first replacement event = %#v, want reconciliation reset", reset)
	}
	if created := <-events; created.Kind != "created" || created.Path != "/workspace/source.txt" || created.Entry == nil {
		t.Fatalf("second replacement event = %#v, want recreated source", created)
	}
}

func TestFileWatcherScopesExternalRenameResetToAffectedSubscriptions(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:     workspace,
		subscriptions: make(map[uint64]fileSubscription),
		watched:       make(map[string]uint32),
	}
	leftID, leftEvents, err := files.subscribe(0, "/workspace/left", "")
	if err != nil {
		t.Fatalf("subscribe left: %v", err)
	}
	defer files.unsubscribe(leftID)
	rightID, rightEvents, err := files.subscribe(0, "/workspace/right", "")
	if err != nil {
		t.Fatalf("subscribe right: %v", err)
	}
	defer files.unsubscribe(rightID)

	files.handle(fsnotify.Event{Name: filepath.Join(workspace.realRoot, "left", "renamed.txt"), Op: fsnotify.Rename})
	if reset := <-leftEvents; reset.Kind != "reset" || reset.Path != "/workspace/left" {
		t.Fatalf("left rename event = %#v, want scoped reset", reset)
	}
	select {
	case event := <-rightEvents:
		t.Fatalf("unrelated right subscription received %#v", event)
	default:
	}

	leftReplayID, leftReplay, err := files.subscribe(0, "/workspace/left", "")
	if err != nil {
		t.Fatalf("subscribe left replay: %v", err)
	}
	defer files.unsubscribe(leftReplayID)
	if reset := <-leftReplay; reset.Kind != "reset" || reset.Path != "/workspace/left" {
		t.Fatalf("left replay event = %#v, want scoped reset", reset)
	}
	rightReplayID, rightReplay, err := files.subscribe(0, "/workspace/right", "")
	if err != nil {
		t.Fatalf("subscribe right replay: %v", err)
	}
	defer files.unsubscribe(rightReplayID)
	select {
	case event := <-rightReplay:
		t.Fatalf("unrelated right replay received %#v", event)
	default:
	}
}

func TestFileWatcherCorrelatesRawAndPairedRenameInEitherOrder(t *testing.T) {
	for _, rawFirst := range []bool{true, false} {
		rawFirst := rawFirst
		t.Run(fmt.Sprintf("raw-first-%t", rawFirst), func(t *testing.T) {
			t.Parallel()
			home := t.TempDir()
			workspace, err := newWorkspace(home)
			if err != nil {
				t.Fatalf("new workspace: %v", err)
			}
			defer workspace.close()
			files := &fileWatcher{
				workspace:        workspace,
				subscriptions:    make(map[uint64]fileSubscription),
				watched:          make(map[string]uint32),
				renameFence:      20 * time.Millisecond,
				expectedRenames:  make(map[string]expectedFileRename),
				completedRenames: make(map[uint64]completedFileRename),
			}
			id, events, err := files.subscribe(0, "/workspace", "")
			if err != nil {
				t.Fatalf("subscribe: %v", err)
			}
			defer files.unsubscribe(id)

			source := filepath.Join(workspace.realRoot, "old-name.txt")
			destination := filepath.Join(workspace.realRoot, "new-name.txt")
			generation, err := files.beginPairedRename(source, destination)
			if err != nil {
				t.Fatalf("begin paired rename: %v", err)
			}
			raw := func() { files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename}) }
			paired := func() {
				files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/new-name.txt"})
			}
			if rawFirst {
				raw()
				paired()
			} else {
				paired()
				raw()
			}
			files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})

			event := <-events
			if event.Kind != "renamed" || event.Path != "/workspace/new-name.txt" || event.PreviousPath != "/workspace/old-name.txt" {
				t.Fatalf("correlated rename event = %#v, want paired destination-side rename", event)
			}
			select {
			case extra := <-events:
				t.Fatalf("correlated rename emitted extra event %#v", extra)
			case <-time.After(3 * files.renameFence):
			}
		})
	}
}

func TestFileWatcherKeepsOrderedRenameFencePastFallbackDeadline(t *testing.T) {
	t.Parallel()
	workspace, err := newWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:     workspace,
		subscriptions: make(map[uint64]fileSubscription),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)
	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if event := <-events; event.Kind != "renamed" {
		t.Fatalf("paired event = %#v, want renamed", event)
	}

	// The kernel's ordered rename echoes can be queued longer than the fallback deadline.
	files.expireCompletedRename(generation)
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	select {
	case extra := <-events:
		t.Fatalf("delayed rename echo escaped its ordered fence: %#v", extra)
	default:
	}
	if len(files.completedRenames) != 0 {
		t.Fatalf("completed fence remained after both ordered echoes: %#v", files.completedRenames)
	}
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	if event := <-events; event.Kind != "created" || event.Path != "/workspace/destination.txt" {
		t.Fatalf("next generation event = %#v, want created", event)
	}
}

func TestFileWatcherPublishesObservedRawRenameWhenPairedRenameIsCanceled(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	select {
	case event := <-events:
		t.Fatalf("raw rename escaped pending correlation: %#v", event)
	default:
	}
	files.cancelPairedRename(source, generation)

	select {
	case removed := <-events:
		if removed.Kind != "removed" || removed.Path != "/workspace/source.txt" {
			t.Fatalf("canceled paired rename event = %#v, want source removal", removed)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled paired rename lost the observed source removal")
	}
}

func TestFileWatcherReconcilesSuppressedRemoveWhenPairedRenameIsCanceled(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace/source.txt", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Remove})
	select {
	case event := <-events:
		t.Fatalf("suppressed source removal escaped before cancellation: %#v", event)
	default:
	}
	files.cancelPairedRename(source, generation)

	select {
	case reset := <-events:
		if reset.Kind != "reset" || reset.Path != "/workspace/source.txt" {
			t.Fatalf("canceled move event = %#v, want scoped reset", reset)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled move lost the suppressed source removal")
	}
}

func TestFileWatcherResetsWhenCanceledRenameSourceStillExists(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	if err := os.WriteFile(source, []byte("replacement"), 0o600); err != nil {
		t.Fatalf("write replacement source: %v", err)
	}
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.cancelPairedRename(source, generation)

	if reset := <-events; reset.Kind != "reset" || reset.Path != "/workspace" {
		t.Fatalf("canceled stale rename event = %#v, want workspace reset", reset)
	}
}

func TestFileWatcherDoesNotCorrelateExternalRenameWithLaterAPIMove(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      20 * time.Millisecond,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	if reset := <-events; reset.Kind != "reset" || reset.Path != "/workspace" {
		t.Fatalf("external rename event = %#v, want reconciliation reset", reset)
	}
	if err := os.WriteFile(source, []byte("replacement"), 0o600); err != nil {
		t.Fatalf("recreate source: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	if created := <-events; created.Kind != "created" || created.Path != "/workspace/source.txt" || created.Entry == nil {
		t.Fatalf("recreation event = %#v, want recreated source", created)
	}
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin API rename: %v", err)
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if paired := <-events; paired.Kind != "renamed" || paired.Path != "/workspace/destination.txt" {
		t.Fatalf("API rename event = %#v, want paired rename", paired)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	select {
	case extra := <-events:
		t.Fatalf("API rename raw echo emitted extra event %#v", extra)
	case <-time.After(3 * files.renameFence):
	}
}

func TestFileWatcherSeparatesQueuedPreOperationRenameFromAPIEcho(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})

	if paired := <-events; paired.Kind != "renamed" || paired.Path != "/workspace/destination.txt" || paired.PreviousPath != "/workspace/source.txt" {
		t.Fatalf("paired event = %#v, want one authoritative API rename", paired)
	}
	select {
	case extra := <-events:
		t.Fatalf("queued pre-operation event or API echo escaped correlation: %#v", extra)
	default:
	}

	if err := os.WriteFile(source, []byte("next generation"), 0o600); err != nil {
		t.Fatalf("recreate source after destination fence: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	if created := <-events; created.Kind != "created" || created.Path != "/workspace/source.txt" {
		t.Fatalf("post-fence create = %#v, want new source generation", created)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	if reset := <-events; reset.Kind != "reset" || reset.Path != "/workspace" {
		t.Fatalf("post-fence rename = %#v, want independent reconciliation reset", reset)
	}
}

func TestFileWatcherPublishesEventsObservedAfterDestinationFence(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	if err := os.WriteFile(source, []byte("original"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	if err := os.Rename(source, destination); err != nil {
		t.Fatalf("rename source: %v", err)
	}
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	if err := os.WriteFile(source, []byte("new generation"), 0o600); err != nil {
		t.Fatalf("recreate source: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	select {
	case event := <-events:
		t.Fatalf("post-fence event escaped before paired rename: %#v", event)
	default:
	}

	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	if paired := <-events; paired.Kind != "renamed" || paired.Path != "/workspace/destination.txt" || paired.PreviousPath != "/workspace/source.txt" {
		t.Fatalf("paired event = %#v, want authoritative rename", paired)
	}
	if created := <-events; created.Kind != "created" || created.Path != "/workspace/source.txt" || created.Entry == nil {
		t.Fatalf("deferred source event = %#v, want recreated source", created)
	}
}

func TestFileWatcherDestinationFenceProtectsLateSourceSubscription(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	kernelWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new kernel watcher: %v", err)
	}
	defer kernelWatcher.Close()
	files := &fileWatcher{
		workspace:        workspace,
		watcher:          kernelWatcher,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	destinationID, destinationEvents, err := files.subscribe(0, "/workspace/destination.txt", "")
	if err != nil {
		t.Fatalf("subscribe destination: %v", err)
	}
	defer files.unsubscribe(destinationID)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination.txt")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired rename: %v", err)
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination.txt"})
	paired := <-destinationEvents
	if paired.Kind != "renamed" || paired.PreviousPath != "/workspace/source.txt" {
		t.Fatalf("destination event = %#v, want paired API rename", paired)
	}

	sourceID, sourceEvents, err := files.subscribe(paired.Sequence, "/workspace/source.txt", "")
	if err != nil {
		t.Fatalf("subscribe source after move: %v", err)
	}
	defer files.unsubscribe(sourceID)
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	select {
	case extra := <-destinationEvents:
		t.Fatalf("destination fence escaped as a raw event: %#v", extra)
	default:
	}

	if err := os.WriteFile(source, []byte("new source generation"), 0o600); err != nil {
		t.Fatalf("recreate source: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	if created := <-sourceEvents; created.Kind != "created" || created.Path != "/workspace/source.txt" {
		t.Fatalf("late subscriber create event = %#v, want new source generation", created)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	if reset := <-sourceEvents; reset.Kind != "reset" || reset.Path != "/workspace/source.txt" {
		t.Fatalf("late subscriber rename event = %#v, want independent reconciliation reset", reset)
	}
}

func TestFileWatcherPreservesEarlierEchoAcrossImmediateFollowUpMove(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	files := &fileWatcher{
		workspace:        workspace,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "a.txt")
	middle := filepath.Join(workspace.realRoot, "b.txt")
	destination := filepath.Join(workspace.realRoot, "c.txt")
	firstGeneration, err := files.beginPairedRename(source, middle)
	if err != nil {
		t.Fatalf("begin first rename: %v", err)
	}
	files.publishPairedRename(source, firstGeneration, fileEvent{Path: "/workspace/b.txt"})
	secondGeneration, err := files.beginPairedRename(middle, destination)
	if err != nil {
		t.Fatalf("begin follow-up rename: %v", err)
	}
	files.publishPairedRename(middle, secondGeneration, fileEvent{Path: "/workspace/c.txt"})

	for _, want := range []struct {
		path     string
		previous string
	}{{path: "/workspace/b.txt", previous: "/workspace/a.txt"}, {path: "/workspace/c.txt", previous: "/workspace/b.txt"}} {
		if event := <-events; event.Kind != "renamed" || event.Path != want.path || event.PreviousPath != want.previous {
			t.Fatalf("paired event = %#v, want %s -> %s", event, want.previous, want.path)
		}
	}

	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: middle, Op: fsnotify.Rename})
	files.handle(fsnotify.Event{Name: middle, Op: fsnotify.Create})
	files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
	select {
	case extra := <-events:
		t.Fatalf("delayed API rename echo escaped correlation: %#v", extra)
	default:
	}
}

func TestFileWatcherReleasesFallbackFenceAfterSourceEcho(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	kernelWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new kernel watcher: %v", err)
	}
	defer kernelWatcher.Close()
	files := &fileWatcher{
		workspace:        workspace,
		watcher:          kernelWatcher,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      time.Second,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	id, events, err := files.subscribe(0, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	source := filepath.Join(workspace.realRoot, "source.txt")
	destination := filepath.Join(workspace.realRoot, "destination", "moved.txt")
	files.mu.Lock()
	files.watched[workspace.realRoot] = 1
	for index := 1; index < fileWatchDirectoryLimit; index++ {
		files.watched[fmt.Sprintf("/workspace/already-watched/%03d", index)] = 1
	}
	files.mu.Unlock()
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin rename at watcher capacity: %v", err)
	}
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination/moved.txt"})
	if paired := <-events; paired.Kind != "renamed" {
		t.Fatalf("paired event = %#v, want renamed", paired)
	}

	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	if err := os.WriteFile(source, []byte("new generation"), 0o600); err != nil {
		t.Fatalf("recreate source: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Create})
	select {
	case created := <-events:
		if created.Kind != "created" || created.Path != "/workspace/source.txt" {
			t.Fatalf("source recreation event = %#v, want created", created)
		}
	case <-time.After(time.Second):
		t.Fatal("fallback rename marker suppressed the recreated source")
	}
}

func TestFileWatcherDeliversCorrelatedRenameBeforeInvalidatingRenamedDirectory(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	workspace, err := newWorkspace(home)
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	defer workspace.close()
	source := filepath.Join(workspace.realRoot, "source")
	if err := os.Mkdir(source, 0o750); err != nil {
		t.Fatalf("create source directory: %v", err)
	}
	kernelWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new kernel watcher: %v", err)
	}
	files := &fileWatcher{
		workspace:        workspace,
		watcher:          kernelWatcher,
		subscriptions:    make(map[uint64]fileSubscription),
		watched:          make(map[string]uint32),
		renameFence:      20 * time.Millisecond,
		expectedRenames:  make(map[string]expectedFileRename),
		completedRenames: make(map[uint64]completedFileRename),
	}
	defer files.close()

	id, events, err := files.subscribe(0, "/workspace/source", source)
	if err != nil {
		t.Fatalf("subscribe source directory: %v", err)
	}
	destination := filepath.Join(workspace.realRoot, "destination")
	generation, err := files.beginPairedRename(source, destination)
	if err != nil {
		t.Fatalf("begin paired directory rename: %v", err)
	}
	files.handle(fsnotify.Event{Name: source, Op: fsnotify.Rename})
	files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination"})

	event, open := <-events
	if !open {
		t.Fatal("source directory subscription closed before delivering the correlated rename")
	}
	if event.Kind != "renamed" || event.Path != "/workspace/destination" || event.PreviousPath != "/workspace/source" {
		t.Fatalf("source directory event = %#v, want correlated rename", event)
	}
	if _, open := <-events; open {
		t.Fatal("source directory subscription remained open after delivering the correlated rename")
	}
	files.mu.Lock()
	_, subscribed := files.subscriptions[id]
	_, watched := files.watched[source]
	files.mu.Unlock()
	if subscribed || watched {
		t.Fatalf("renamed directory remained registered: subscribed=%t watched=%t", subscribed, watched)
	}
}

func TestFileWatcherDeliversPairedRenameToSourceAndDestinationWatchers(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	sourceID, sourceEvents, err := files.subscribe(0, "/workspace/source", "")
	if err != nil {
		t.Fatalf("subscribe source: %v", err)
	}
	defer files.unsubscribe(sourceID)
	destinationID, destinationEvents, err := files.subscribe(0, "/workspace/destination", "")
	if err != nil {
		t.Fatalf("subscribe destination: %v", err)
	}
	defer files.unsubscribe(destinationID)

	files.publish(fileEvent{
		Kind:         "renamed",
		Path:         "/workspace/destination/file.txt",
		PreviousPath: "/workspace/source/file.txt",
	})
	receive := func(name string, events <-chan fileEvent) fileEvent {
		t.Helper()
		select {
		case event := <-events:
			return event
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for %s watcher event", name)
			return fileEvent{}
		}
	}
	for name, events := range map[string]<-chan fileEvent{
		"source":      sourceEvents,
		"destination": destinationEvents,
	} {
		event := receive(name, events)
		if event.Kind != "renamed" || event.Path != "/workspace/destination/file.txt" || event.PreviousPath != "/workspace/source/file.txt" {
			t.Fatalf("%s watcher event = %#v, want paired rename", name, event)
		}
	}

	replayID, replay, err := files.subscribe(0, "/workspace/source", "")
	if err != nil {
		t.Fatalf("subscribe source replay: %v", err)
	}
	defer files.unsubscribe(replayID)
	if event := receive("source replay", replay); event.Kind != "renamed" || event.PreviousPath != "/workspace/source/file.txt" {
		t.Fatalf("source replay event = %#v, want paired rename", event)
	}
}

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
	id, events, err := files.subscribe(0, "/workspace", "")
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

	id, events, err = files.subscribe(files.sequence, "/workspace", "")
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

func TestFileWatcherSignalsCursorFromPreviousProcess(t *testing.T) {
	t.Parallel()
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	id, events, err := files.subscribe(42, "/workspace", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer files.unsubscribe(id)

	reset := <-events
	if reset.Kind != "reset" || reset.Sequence != 0 || reset.Path != "/workspace" {
		t.Fatalf("replay reset = %#v", reset)
	}
}

func TestFileWatcherSubscriberLimit(t *testing.T) {
	t.Parallel()
	if fileSubscriberLimit != fileWatchDirectoryLimit*2 {
		t.Fatalf("subscriber limit = %d, want reconnect overlap for %d directories", fileSubscriberLimit, fileWatchDirectoryLimit)
	}
	files := &fileWatcher{subscriptions: make(map[uint64]fileSubscription)}
	ids := make([]uint64, 0, fileSubscriberLimit)
	for range fileSubscriberLimit {
		id, _, err := files.subscribe(0, "/workspace", "")
		if err != nil {
			t.Fatalf("subscribe within limit: %v", err)
		}
		ids = append(ids, id)
	}
	if _, _, err := files.subscribe(0, "/workspace", ""); err == nil {
		t.Fatal("subscriber limit was not enforced")
	}
	for _, id := range ids {
		files.unsubscribe(id)
	}
}

func TestFileWatcherReleasesMoveResourcesAfterSubscribersClose(t *testing.T) {
	for _, outcome := range []string{"rename", "cancel", "overflow", "pending-overflow"} {
		t.Run(outcome, func(t *testing.T) {
			t.Parallel()
			workspace, err := newWorkspace(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer workspace.close()
			left := filepath.Join(workspace.realRoot, "left")
			right := filepath.Join(workspace.realRoot, "right")
			for _, directory := range []string{left, right} {
				if err := os.Mkdir(directory, 0o750); err != nil {
					t.Fatal(err)
				}
			}
			source := filepath.Join(left, "source.txt")
			destination := filepath.Join(right, "destination.txt")
			if err := os.WriteFile(source, []byte("move"), 0o600); err != nil {
				t.Fatal(err)
			}
			files, err := newFileWatcher(workspace)
			if err != nil {
				t.Fatal(err)
			}
			defer files.close()
			first, _, err := files.subscribe(0, "/workspace/left", left)
			if err != nil {
				t.Fatal(err)
			}
			second, _, err := files.subscribe(0, "/workspace/right", right)
			if err != nil {
				t.Fatal(err)
			}
			generation, err := files.beginPairedRename(source, destination)
			if err != nil {
				t.Fatal(err)
			}
			files.unsubscribe(first)
			files.unsubscribe(second)
			if outcome == "cancel" {
				files.cancelPairedRename(source, generation)
			} else {
				if outcome == "pending-overflow" {
					files.handleWatcherError(fsnotify.ErrEventOverflow)
				}
				if outcome == "rename" {
					if err := os.Rename(source, destination); err != nil {
						t.Fatal(err)
					}
				}
				files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/right/destination.txt"})
				if outcome == "overflow" {
					files.handleWatcherError(fsnotify.ErrEventOverflow)
				}
			}
			deadline := time.Now().Add(time.Second)
			for {
				files.mu.Lock()
				pending, completed, watched := len(files.expectedRenames), len(files.completedRenames), len(files.watched)
				files.mu.Unlock()
				if pending == 0 && completed == 0 && watched == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("move retained resources: pending=%d completed=%d watched=%d", pending, completed, watched)
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}
