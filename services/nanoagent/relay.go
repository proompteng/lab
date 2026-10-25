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
type relayConfiguration struct {
	ConnectionID string           `json:"connectionId"`
	Endpoint     string           `json:"endpoint"`
	GrantID      string           `json:"grantId"`
	Credential   string           `json:"credential"`
	Operations   []relayOperation `json:"operations"`
	KeyFile      string           `json:"keyFile,omitempty"`
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
	if metadata, err := os.Lstat(keyFile); err == nil && (!metadata.Mode().IsRegular() || metadata.Mode().Perm()&0077 != 0) {
		return nil, errors.New("connector identity must be an owner-only regular file")
	}
	raw, err := os.ReadFile(keyFile)
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

func (supervisor *codexSupervisor) relayCall(ctx context.Context, method string, params json.RawMessage) (codexCallResult, error) {
	if !supervisor.connectorsEnabled {
		return codexCallResult{}, errors.New("connectors are not enabled")
	}
	supervisor.relayMu.Lock()
	defer supervisor.relayMu.Unlock()
	identity, err := relayIdentity(supervisor.relayRoot)
	if err != nil {
		return codexCallResult{}, err
	}
	if method == "relay/identity" {
		raw, _ := json.Marshal(identity)
		return codexCallResult{result: raw}, nil
	}
	if len(params) > 512*1024 {
		return codexCallResult{}, errors.New("connector configuration is too large")
	}
	var config relayConfiguration
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || !relayUUID.MatchString(config.ConnectionID) {
		return codexCallResult{}, errors.New("invalid connector configuration")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return codexCallResult{}, errors.New("invalid connector configuration")
	}
	serverName := "relay_" + strings.ReplaceAll(config.ConnectionID, "-", "")
	file := filepath.Join(supervisor.relayRoot, config.ConnectionID+".json")
	var value any
	switch method {
	case "relay/configure":
		endpoint, parseErr := url.Parse(config.Endpoint)
		if parseErr != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Path != "/api/tengri/connectors/agent" || endpoint.RawQuery != "" || endpoint.Fragment != "" || !relayUUID.MatchString(config.GrantID) || !relayCredential.MatchString(config.Credential) || len(config.Operations) == 0 || len(config.Operations) > 128 || config.KeyFile != "" {
			return codexCallResult{}, errors.New("invalid connector grant")
		}
		seen := map[string]bool{}
		for _, operation := range config.Operations {
			var schema map[string]json.RawMessage
			if !relayName.MatchString(operation.Name) || seen[operation.Name] || len(operation.Description) > 4096 || json.Unmarshal(operation.InputSchema, &schema) != nil || string(schema["type"]) != `"object"` {
				return codexCallResult{}, errors.New("invalid connector operation")
			}
			seen[operation.Name] = true
		}
		config.KeyFile = filepath.Join(supervisor.relayRoot, "identity.pem")
		raw, _ := json.Marshal(config)
		temp, createErr := os.CreateTemp(supervisor.relayRoot, ".grant-")
		if createErr != nil {
			return codexCallResult{}, createErr
		}
		defer os.Remove(temp.Name())
		_, writeErr := temp.Write(raw)
		if writeErr == nil {
			writeErr = temp.Sync()
		}
		closeErr := temp.Close()
		if writeErr != nil {
			return codexCallResult{}, writeErr
		}
		if closeErr != nil {
			return codexCallResult{}, closeErr
		}
		if err := os.Rename(temp.Name(), file); err != nil {
			return codexCallResult{}, err
		}
		if err := relaySyncDirectory(supervisor.relayRoot); err != nil {
			return codexCallResult{}, err
		}
		value = map[string]any{"command": "/usr/local/bin/tengri-relay", "args": []string{file}, "required": false, "tool_timeout_sec": 40}
	case "relay/remove":
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return codexCallResult{}, err
		}
		if err := relaySyncDirectory(supervisor.relayRoot); err != nil {
			return codexCallResult{}, err
		}
		value = map[string]any{"command": "/usr/local/bin/tengri-relay", "args": []string{file}, "required": false, "enabled": false}
	default:
		return codexCallResult{}, errors.New("unsupported connector configuration action")
	}
	edits, _ := json.Marshal(map[string]any{"edits": []any{map[string]any{"keyPath": "mcp_servers." + serverName, "mergeStrategy": "replace", "value": value}}, "reloadUserConfig": true})
	if _, err := supervisor.request(ctx, "config/batchWrite", edits, true, nil); err != nil {
		return codexCallResult{}, errors.New("connector configuration could not be applied")
	}
	if _, err := supervisor.request(ctx, "config/mcpServer/reload", json.RawMessage(`null`), true, nil); err != nil {
		return codexCallResult{}, errors.New("connector tools could not be refreshed")
	}
	raw, _ := json.Marshal(map[string]bool{"configured": method == "relay/configure"})
	return codexCallResult{result: raw}, nil
}

func relaySyncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
