package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type relayOperation struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	ReadOnly    bool            `json:"readOnly"`
}
type relayBinding struct {
	Service    string `json:"service"`
	ID         string `json:"id"`
	Generation string `json:"generation"`
}
type relayConfiguration struct {
	ConnectionID string `json:"connectionId"`
	relayGeneration
	DelegationID  string           `json:"delegationId"`
	ConnectorID   string           `json:"connectorId"`
	ClientService string           `json:"clientService"`
	Binding       relayBinding     `json:"binding"`
	Endpoint      string           `json:"endpoint"`
	Credential    string           `json:"credential"`
	Operations    []relayOperation `json:"operations"`
	KeyFile       string           `json:"keyFile,omitempty"`
}

var relayUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var relayName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)
var relayCredential = regexp.MustCompile(`^[a-zA-Z0-9_-]{43}$`)

func relayIdentity(root string) (map[string]string, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("connector identity storage is unavailable")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, errors.New("create connector identity storage")
	}
	keyFile := filepath.Join(root, "identity.pem")
	raw, err := relayPrivateFile(keyFile, 16384)
	if errors.Is(err, os.ErrNotExist) {
		key, genErr := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		der, marshalErr := x509.MarshalPKCS8PrivateKey(key)
		if marshalErr != nil {
			return nil, marshalErr
		}
		raw = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
		file, openErr := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if openErr != nil {
			return nil, openErr
		}
		_, writeErr := file.Write(raw)
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr != nil {
			return nil, writeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if err := relaySyncDirectory(root); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, errors.New("read connector identity")
	}
	if len(raw) > 16384 {
		return nil, errors.New("invalid connector identity")
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("invalid connector identity")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("invalid connector identity")
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("P-256 connector identity required")
	}
	public := struct {
		Crv string `json:"crv"`
		Kty string `json:"kty"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}{"P-256", "EC", base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))}
	encoded, _ := json.Marshal(public)
	hash := sha256.Sum256(encoded)
	id := hash[:16]
	id[6] = (id[6] & 0x0f) | 0x50
	id[8] = (id[8] & 0x3f) | 0x80
	agentID := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	// Hash before setting UUID version/variant bits: the thumbprint is RFC 7638.
	thumbprint := sha256.Sum256(encoded)
	return map[string]string{"agentId": agentID, "proofKeyThumbprint": base64.RawURLEncoding.EncodeToString(thumbprint[:])}, nil
}

type relayRemoval struct {
	ConnectionID string `json:"connectionId"`
	DelegationID string `json:"delegationId,omitempty"`
	relayGeneration
}

func relayDecode(params json.RawMessage, target any) error {
	if len(params) > 512*1024 {
		return errors.New("connector configuration is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return errors.New("invalid connector configuration")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("invalid connector configuration")
	}
	return nil
}

func (supervisor *codexSupervisor) relayCall(ctx context.Context, method string, params json.RawMessage) (codexCallResult, error) {
	supervisor.relayMu.Lock()
	defer supervisor.relayMu.Unlock()
	identity, err := relayIdentity(supervisor.relayRoot)
	if err != nil {
		return codexCallResult{}, err
	}
	var result any
	switch method {
	case "relay/identity":
		installed, err := relayInstallations(supervisor.relayRoot)
		if err != nil {
			return codexCallResult{}, err
		}
		result = map[string]any{"agentId": identity["agentId"], "proofKeyThumbprint": identity["proofKeyThumbprint"], "connections": installed}
	case "relay/configure":
		var config relayConfiguration
		if err := relayDecode(params, &config); err != nil {
			return codexCallResult{}, err
		}
		if err := supervisor.relayConfigure(ctx, config); err != nil {
			return codexCallResult{}, err
		}
		result = map[string]any{"configured": true, "connectionId": config.ConnectionID, "delegationId": config.DelegationID, "proofKeyThumbprint": identity["proofKeyThumbprint"], "recoveryGeneration": fmt.Sprint(config.RecoveryGeneration), "credentialGeneration": fmt.Sprint(config.CredentialGeneration)}
	case "relay/remove":
		var removal relayRemoval
		if err := relayDecode(params, &removal); err != nil {
			return codexCallResult{}, err
		}
		removed, err := supervisor.relayRemove(ctx, removal)
		if err != nil {
			return codexCallResult{}, err
		}
		result = map[string]any{"configured": false, "removed": removed, "connectionId": removal.ConnectionID, "delegationId": removal.DelegationID, "recoveryGeneration": fmt.Sprint(removal.RecoveryGeneration), "credentialGeneration": fmt.Sprint(removal.CredentialGeneration)}
	default:
		return codexCallResult{}, errors.New("unsupported connector configuration action")
	}
	raw, _ := json.Marshal(result)
	return codexCallResult{result: raw}, nil
}

func (supervisor *codexSupervisor) relayApply(ctx context.Context, connectionID, file string, enabled bool) error {
	value := map[string]any{"command": "/usr/local/bin/tengri-relay", "args": []string{file}, "required": false, "tool_timeout_sec": 40, "enabled": enabled}
	serverName := "relay_" + strings.ReplaceAll(connectionID, "-", "")
	edits, _ := json.Marshal(map[string]any{"edits": []any{map[string]any{"keyPath": "mcp_servers." + serverName, "mergeStrategy": "replace", "value": value}}, "reloadUserConfig": true})
	if _, err := supervisor.request(ctx, "config/batchWrite", edits, true, nil); err != nil {
		return errors.New("connector configuration could not be applied")
	}
	if _, err := supervisor.request(ctx, "config/mcpServer/reload", json.RawMessage(`null`), true, nil); err != nil {
		return errors.New("connector tools could not be refreshed")
	}
	return nil
}

func (supervisor *codexSupervisor) relayConfigure(ctx context.Context, config relayConfiguration) error {
	endpoint, parseErr := url.Parse(config.Endpoint)
	if !relayUUID.MatchString(config.ConnectionID) || !relayUUID.MatchString(config.DelegationID) || !config.relayGeneration.valid() || parseErr != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Path != "/api/platform/relay/agent" || endpoint.RawQuery != "" || endpoint.Fragment != "" || !relayName.MatchString(config.ConnectorID) || config.ClientService != "tengri-web" || config.Binding.Service != "tengri" || !relayUUID.MatchString(config.Binding.ID) || !relayUUID.MatchString(config.Binding.Generation) || !relayCredential.MatchString(config.Credential) || len(config.Operations) == 0 || len(config.Operations) > 128 || config.KeyFile != "" {
		return errors.New("invalid connector grant")
	}
	seen := map[string]bool{}
	for _, operation := range config.Operations {
		var schema map[string]json.RawMessage
		if !relayName.MatchString(operation.Name) || seen[operation.Name] || !operation.ReadOnly || len(operation.Description) > 4096 || json.Unmarshal(operation.InputSchema, &schema) != nil || string(schema["type"]) != `"object"` {
			return errors.New("invalid read-only connector operation")
		}
		seen[operation.Name] = true
	}
	config.KeyFile = filepath.Join(supervisor.relayRoot, "identity.pem")
	raw, _ := json.Marshal(config)
	hash := relayConfigurationHash(raw)
	previous, err := relayLoadState(supervisor.relayRoot, config.ConnectionID)
	if err != nil {
		return err
	}
	if previous != nil {
		order := config.relayGeneration.compare(previous.relayGeneration)
		if order < 0 || (order == 0 && (previous.Removed || previous.DelegationID != config.DelegationID || previous.ConfigurationHash != hash)) {
			return errors.New("connector installation is stale or changed")
		}
	}
	state := relayState{ConnectionID: config.ConnectionID, DelegationID: config.DelegationID, relayGeneration: config.relayGeneration, ConfigurationHash: hash}
	if err := relaySaveState(supervisor.relayRoot, state); err != nil {
		return err
	}
	file := filepath.Join(supervisor.relayRoot, config.ConnectionID+".json")
	if err := relayWriteFile(supervisor.relayRoot, file, raw); err != nil {
		return err
	}
	if err := supervisor.relayApply(ctx, config.ConnectionID, file, true); err != nil {
		return err
	}
	state.Applied = true
	return relaySaveState(supervisor.relayRoot, state)
}

func (supervisor *codexSupervisor) relayRemove(ctx context.Context, removal relayRemoval) (bool, error) {
	if !relayUUID.MatchString(removal.ConnectionID) || (removal.DelegationID != "" && !relayUUID.MatchString(removal.DelegationID)) || !removal.relayGeneration.valid() {
		return false, errors.New("invalid connector removal")
	}
	previous, err := relayLoadState(supervisor.relayRoot, removal.ConnectionID)
	if err != nil {
		return false, err
	}
	if previous != nil {
		order := removal.relayGeneration.compare(previous.relayGeneration)
		if order < 0 || (!previous.Removed && removal.DelegationID != "" && previous.DelegationID != removal.DelegationID) {
			return false, nil
		}
		if order == 0 && previous.Removed && previous.Applied {
			return true, nil
		}
	}
	state := relayState{ConnectionID: removal.ConnectionID, DelegationID: removal.DelegationID, relayGeneration: removal.relayGeneration, Removed: true}
	if err := relaySaveState(supervisor.relayRoot, state); err != nil {
		return false, err
	}
	file := filepath.Join(supervisor.relayRoot, removal.ConnectionID+".json")
	if err := supervisor.relayApply(ctx, removal.ConnectionID, file, false); err != nil {
		return false, err
	}
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := relaySyncDirectory(supervisor.relayRoot); err != nil {
		return false, err
	}
	state.Applied = true
	if err := relaySaveState(supervisor.relayRoot, state); err != nil {
		return false, err
	}
	return true, nil
}

func relaySyncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
