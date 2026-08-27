package main

import (
	"slices"
	"strings"
	"testing"
)

func TestChildEnvironmentRemovesBootstrapCredential(t *testing.T) {
	t.Setenv(bootstrapTokenEnvironmentKey, "guest-control-secret")

	environment := childEnvironment("TERM=xterm-256color")
	for _, item := range environment {
		if strings.HasPrefix(item, bootstrapTokenEnvironmentKey+"=") {
			t.Fatal("child environment retained the Nanoagent bootstrap credential")
		}
	}
	if !containsEnvironmentEntry(environment, "TERM=xterm-256color") {
		t.Fatal("child environment omitted explicitly supplied terminal settings")
	}
}

func TestChildProcessEnvironmentPreservesSimilarKeys(t *testing.T) {
	t.Parallel()
	environment := childProcessEnvironment(
		[]string{
			"PATH=/usr/bin",
			bootstrapTokenEnvironmentKey + "=guest-secret",
			"MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained",
		},
		"TERM=xterm-256color",
	)
	if slices.Contains(environment, bootstrapTokenEnvironmentKey+"=guest-secret") {
		t.Fatal("bootstrap token remained in the child environment")
	}
	for _, expected := range []string{"PATH=/usr/bin", "MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained", "TERM=xterm-256color"} {
		if !slices.Contains(environment, expected) {
			t.Fatalf("child environment omitted %q: %#v", expected, environment)
		}
	}
}

func containsEnvironmentEntry(environment []string, expected string) bool {
	for _, item := range environment {
		if item == expected {
			return true
		}
	}
	return false
}
