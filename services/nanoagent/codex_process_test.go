package main

import (
	"os"
	"testing"
)

func TestMain(tests *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "codex-process" {
		main()
		os.Exit(0)
	}
	os.Exit(tests.Run())
}
