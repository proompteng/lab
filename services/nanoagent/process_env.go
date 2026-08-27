package main

import (
	"os"
	"strings"
)

const bootstrapTokenEnvironmentKey = "MICROVM_BOOTSTRAP_TOKEN"

func childEnvironment(extra ...string) []string {
	return childProcessEnvironment(os.Environ(), extra...)
}

func childProcessEnvironment(source []string, extra ...string) []string {
	environment := make([]string, 0, len(source)+len(extra))
	for _, item := range source {
		key, _, found := strings.Cut(item, "=")
		if found && key == bootstrapTokenEnvironmentKey {
			continue
		}
		environment = append(environment, item)
	}
	return append(environment, extra...)
}
