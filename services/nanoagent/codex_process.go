package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type codexGenerationReceipt struct {
	Version          int    `json:"version"`
	Generation       string `json:"generation"`
	BootID           string `json:"bootId"`
	ProcessesStopped bool   `json:"processesStopped"`
}

func codexGenerationPath(workspace, generation string) string {
	return filepath.Join(workspace, ".tengri", "codex-generations", generation+".json")
}

func validCodexGeneration(generation string) bool {
	_, err := hex.DecodeString(generation)
	return len(generation) == 32 && err == nil && generation == strings.ToLower(generation)
}

func (supervisor *codexSupervisor) generationProcessesStopped(generation string) bool {
	if !validCodexGeneration(generation) {
		return false
	}
	path := codexGenerationPath(supervisor.cwd, generation)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return false
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var receipt codexGenerationReceipt
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&receipt) != nil || decoder.Decode(new(any)) != io.EOF ||
		receipt.Version != 1 || receipt.Generation != generation || !codexOperationID.MatchString(receipt.BootID) {
		return false
	}
	if receipt.ProcessesStopped {
		return true
	}
	boot, err := os.ReadFile(bootIDPath)
	current := strings.TrimSpace(string(boot))
	return err == nil && codexOperationID.MatchString(current) && receipt.BootID != current
}
