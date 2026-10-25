package config

import (
	"os"

	"github.com/joho/godotenv"
)

var candidateEnvFiles = []string{
	".env",
	"../.env",
	"../../.env",
	"services/miel/.env",
}

// LoadDotEnv attempts to load a .env file for local development. It is safe to
// call multiple times; the first readable file wins.
func LoadDotEnv() {
	for _, path := range candidateEnvFiles {
		if _, err := os.Stat(path); err == nil {
			godotenv.Overload(path)
			return
		}
	}
}
