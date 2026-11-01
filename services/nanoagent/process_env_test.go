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
			"HOME=/root",
			bootstrapTokenEnvironmentKey + "=guest-secret",
			bootstrapTokenFDEnvironmentKey + "=7",
			reexecWrapperEnvironmentKey + "=/usr/bin/tini",
			"MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained",
		},
		"TERM=xterm-256color",
		"HOME=/home/nanoagent",
	)
	if slices.Contains(environment, bootstrapTokenEnvironmentKey+"=guest-secret") {
		t.Fatal("bootstrap token remained in the child environment")
	}
	if slices.Contains(environment, bootstrapTokenFDEnvironmentKey+"=7") {
		t.Fatal("bootstrap token transport descriptor remained in the child environment")
	}
	if slices.Contains(environment, reexecWrapperEnvironmentKey+"=/usr/bin/tini") {
		t.Fatal("bootstrap re-exec wrapper remained in the child environment")
	}
	for _, expected := range []string{
		"PATH=/usr/bin",
		"MICROVM_BOOTSTRAP_TOKEN_SUFFIX=retained",
		"TERM=xterm-256color",
		"HOME=/home/nanoagent",
	} {
		if !slices.Contains(environment, expected) {
			t.Fatalf("child environment omitted %q: %#v", expected, environment)
		}
	}
	if slices.Contains(environment, "HOME=/root") {
		t.Fatal("child environment retained the replaced HOME")
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

func TestChildProcessEnvironmentDoesNotPassPlatformTelemetry(t *testing.T) {
	environment := childProcessEnvironment([]string{
		"PATH=/usr/bin", "SENTRY_DSN=http://platform-ingest/8",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://platform-collector/v1/traces",
		"APP_SOURCE_REVISION=platform-source", "MY_APP_SOURCE_REVISION=user-source",
	}, "HOME=/home/nanoagent")
	for _, value := range environment {
		key, _, _ := strings.Cut(value, "=")
		if key == "SENTRY_DSN" || key == "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" || key == "APP_SOURCE_REVISION" {
			t.Fatalf("platform telemetry leaked to a user subprocess: %s", key)
		}
	}
	for _, value := range []string{"PATH=/usr/bin", "HOME=/home/nanoagent", "MY_APP_SOURCE_REVISION=user-source"} {
		if !slices.Contains(environment, value) {
			t.Fatalf("user subprocess lost its environment: %s", value)
		}
	}
}
