package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type relayGeneration struct {
	RecoveryGeneration   uint64 `json:"recoveryGeneration,string"`
	CredentialGeneration uint64 `json:"credentialGeneration,string"`
}

func (generation relayGeneration) valid() bool {
	return generation.RecoveryGeneration > 0 && generation.CredentialGeneration > 0
}

func (generation relayGeneration) compare(other relayGeneration) int {
	if generation.RecoveryGeneration < other.RecoveryGeneration || (generation.RecoveryGeneration == other.RecoveryGeneration && generation.CredentialGeneration < other.CredentialGeneration) {
		return -1
	}
	if generation == other {
		return 0
	}
	return 1
}

type relayState struct {
	ConnectionID string `json:"connectionId"`
	DelegationID string `json:"delegationId,omitempty"`
	relayGeneration
	Removed           bool   `json:"removed"`
	Applied           bool   `json:"applied"`
	ConfigurationHash string `json:"configurationHash,omitempty"`
}

type relayInstallation struct {
	ConnectionID string `json:"connectionId"`
	DelegationID string `json:"delegationId,omitempty"`
	relayGeneration
	Configured bool `json:"configured"`
}

func relayPrivateFile(file string, limit int64) ([]byte, error) {
	opened, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer opened.Close()
	metadata, err := opened.Stat()
	if err != nil {
		return nil, err
	}
	owner, ok := metadata.Sys().(*syscall.Stat_t)
	if !metadata.Mode().IsRegular() || metadata.Mode().Perm()&0077 != 0 || metadata.Size() > limit || !ok || owner.Uid != uint32(os.Getuid()) {
		return nil, errors.New("connector state requires an owner-only regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(opened, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("connector state exceeds its byte budget")
	}
	return raw, nil
}

func relayWriteFile(root, file string, raw []byte) error {
	temp, err := os.CreateTemp(root, ".relay-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(raw)
	if writeErr == nil {
		writeErr = temp.Sync()
	}
	closeErr := temp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(temp.Name(), file); err != nil {
		return err
	}
	return relaySyncDirectory(root)
}

func relayStatePath(root, id string) string {
	return filepath.Join(root, id+".state.json")
}

func relayLoadState(root, id string) (*relayState, error) {
	raw, err := relayPrivateFile(relayStatePath(root, id), 16384)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state relayState
	if json.Unmarshal(raw, &state) != nil || state.ConnectionID != id || !state.relayGeneration.valid() || (!state.Removed && !relayUUID.MatchString(state.DelegationID)) {
		return nil, errors.New("invalid connector generation state")
	}
	return &state, nil
}

func relaySaveState(root string, state relayState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return relayWriteFile(root, relayStatePath(root, state.ConnectionID), raw)
}

func relayConfigurationHash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func relayInstallations(root string) ([]relayInstallation, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	installed := []relayInstallation{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".state.json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".state.json")
		if !relayUUID.MatchString(id) {
			return nil, errors.New("invalid connector state identity")
		}
		state, err := relayLoadState(root, id)
		if err != nil {
			return nil, err
		}
		if state == nil || state.Removed {
			continue
		}
		configured := false
		if state.Applied {
			raw, err := relayPrivateFile(filepath.Join(root, id+".json"), 512*1024)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			configured = err == nil && relayConfigurationHash(raw) == state.ConfigurationHash
		}
		installed = append(installed, relayInstallation{ConnectionID: id, DelegationID: state.DelegationID, relayGeneration: state.relayGeneration, Configured: configured})
	}
	return installed, nil
}
