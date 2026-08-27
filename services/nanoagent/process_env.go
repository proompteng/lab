package main

import (
	"os"
	"strings"
)

func childEnvironment(extra ...string) []string {
	return childProcessEnvironment(os.Environ(), extra...)
}

func childProcessEnvironment(source []string, extra ...string) []string {
	overrides := make(map[string]struct{}, len(extra))
	for _, item := range extra {
		key, _, found := strings.Cut(item, "=")
		if found {
			overrides[key] = struct{}{}
		}
	}
	environment := make([]string, 0, len(source)+len(extra))
	for _, item := range source {
		key, _, found := strings.Cut(item, "=")
		_, overridden := overrides[key]
		if found && (key == bootstrapTokenEnvironmentKey || key == bootstrapTokenFDEnvironmentKey || overridden) {
			continue
		}
		environment = append(environment, item)
	}
	return append(environment, extra...)
}
