package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"
)

func TestFileWatcherReleasesMissingSourceEcho(t *testing.T) {
	for _, afterPublication := range []bool{false, true} {
		name := "before-publication"
		if afterPublication {
			name = "after-publication"
		}
		t.Run(name, func(t *testing.T) {
			workspace, err := newWorkspace(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer workspace.close()
			watcher, err := fsnotify.NewWatcher()
			if err != nil {
				t.Fatal(err)
			}
			defer watcher.Close()
			files := &fileWatcher{workspace: workspace, watcher: watcher, watched: make(map[string]uint32), subscriptions: make(map[uint64]fileSubscription)}
			sourceDirectory := filepath.Join(workspace.realRoot, "source")
			destinationDirectory := filepath.Join(workspace.realRoot, "destination")
			for _, directory := range []string{sourceDirectory, destinationDirectory} {
				if err := os.Mkdir(directory, 0o750); err != nil {
					t.Fatal(err)
				}
			}
			// Exercise more operations than the directory budget, without relying on
			// kernel delivery or sleeps: only the destination echo can arrive.
			for i := 0; i <= fileWatchDirectoryLimit; i++ {
				id, _, err := files.subscribe(0, "/workspace/source", sourceDirectory)
				if err != nil {
					t.Fatal(err)
				}
				source := filepath.Join(sourceDirectory, "file.txt")
				destination := filepath.Join(destinationDirectory, "file.txt")
				generation, err := files.beginPairedRename(source, destination)
				if err != nil {
					t.Fatal(err)
				}
				if afterPublication {
					files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination/file.txt"})
				}
				files.unsubscribe(id)
				if !afterPublication {
					files.publishPairedRename(source, generation, fileEvent{Path: "/workspace/destination/file.txt"})
				}
				if files.watched[destinationDirectory] != 1 {
					t.Fatal("destination fence was released before its echo")
				}
				files.handle(fsnotify.Event{Name: destination, Op: fsnotify.Create})
				if len(files.completedRenames) != 0 || len(files.watched) != 0 {
					t.Fatalf("operation %d retained completed=%d watches=%v", i, len(files.completedRenames), files.watched)
				}
			}
		})
	}
}
