package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRelayIdentityIsStablePrivateAndNeverReturnsItsKey(t *testing.T) {
	root := t.TempDir()
	first, err := relayIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := relayIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if first["agentId"] != second["agentId"] || first["proofKeyThumbprint"] != second["proofKeyThumbprint"] || len(first["proofKeyThumbprint"]) != 43 || !relayUUID.MatchString(first["agentId"]) {
		t.Fatal("identity changed or was invalid")
	}
	raw, _ := json.Marshal(first)
	if strings.Contains(string(raw), "PRIVATE") {
		t.Fatal("private identity returned")
	}
	file := filepath.Join(root, "identity.pem")
	if err := os.Chmod(file, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := relayIdentity(root); err == nil {
		t.Fatal("accepted a public private key")
	}
	if err := os.Chmod(file, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := relayIdentity(root); err == nil {
		t.Fatal("silently replaced a corrupt identity")
	}
}

func TestRelayConfigurationInstallsOnlyAScopedGrantAndReloadsTools(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	supervisor.relayRoot = t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := "11111111-1111-4111-8111-111111111111"
	credential := strings.Repeat("a", 43)
	config := relayFixtureConfiguration("22222222-2222-4222-8222-222222222222", 1, 1)
	config.Operations = append(config.Operations, relayOperation{Name: "start_run", Description: "Start a run", ReadOnly: new(bool), InputSchema: json.RawMessage(`{"type":"object"}`)})
	params, _ := json.Marshal(config)
	done := make(chan error, 1)
	go func() {
		result, err := supervisor.call(ctx, "relay/configure", params)
		if err == nil && strings.Contains(string(result.result), credential) {
			t.Error("credential was returned")
		}
		done <- err
	}()
	write := readCodexWireRequest(t, writer)
	if write.Method != "config/batchWrite" || strings.Contains(string(write.Params), credential) {
		t.Fatal("configuration leaked a credential or used the wrong method")
	}
	var batch struct {
		Edits []struct {
			KeyPath string         `json:"keyPath"`
			Value   map[string]any `json:"value"`
		} `json:"edits"`
	}
	if json.Unmarshal(write.Params, &batch) != nil || len(batch.Edits) != 1 || batch.Edits[0].KeyPath != "mcp_servers.relay_11111111111141118111111111111111" {
		t.Fatalf("unexpected config edit: %s", write.Params)
	}
	supervisor.resolveResponse(codexRPCMessage{ID: write.ID, Result: json.RawMessage(`{}`)})
	reload := readCodexWireRequest(t, writer)
	if reload.Method != "config/mcpServer/reload" {
		t.Fatal("tools were not reloaded")
	}
	supervisor.resolveResponse(codexRPCMessage{ID: reload.ID, Result: json.RawMessage(`{}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(supervisor.relayRoot, connection+".json")
	metadata, err := os.Stat(file)
	if err != nil || metadata.Mode().Perm() != 0600 {
		t.Fatal("grant file was not private")
	}
	raw, err := os.ReadFile(file)
	if err != nil || !strings.Contains(string(raw), credential) || strings.Contains(string(raw), "provider-token") {
		t.Fatal("grant configuration was not persisted")
	}
	var installed relayConfiguration
	if json.Unmarshal(raw, &installed) != nil || len(installed.Operations) != 2 || installed.Operations[0].ReadOnly == nil || !*installed.Operations[0].ReadOnly || installed.Operations[1].ReadOnly == nil || *installed.Operations[1].ReadOnly {
		t.Fatal("installed operations lost their read/write classification")
	}
	go func() {
		_, err := supervisor.call(ctx, "relay/remove", json.RawMessage(`{"connectionId":"11111111-1111-4111-8111-111111111111","recoveryGeneration":"1","credentialGeneration":"2"}`))
		done <- err
	}()
	write = readCodexWireRequest(t, writer)
	if json.Unmarshal(write.Params, &batch) != nil || batch.Edits[0].Value["enabled"] != false {
		t.Fatal("connector was not disabled")
	}
	supervisor.resolveResponse(codexRPCMessage{ID: write.ID, Result: json.RawMessage(`{}`)})
	reload = readCodexWireRequest(t, writer)
	supervisor.resolveResponse(codexRPCMessage{ID: reload.ID, Result: json.RawMessage(`{}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("scoped grant was retained after removal")
	}
}

func TestRelayConfigurationRejectsInjectedFilesAndDestinations(t *testing.T) {
	supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
	supervisor.relayRoot = t.TempDir()
	for _, raw := range []string{
		`{"delegationId":"../../escape"}`,
		`{"delegationId":"11111111-1111-4111-8111-111111111111","keyFile":"/etc/shadow"}`,
		`{"delegationId":"11111111-1111-4111-8111-111111111111","endpoint":"http://insecure.example","credential":"a"}`,
		`{"delegationId":"11111111-1111-4111-8111-111111111111","arbitraryCommand":"sh"}`,
	} {
		if _, err := supervisor.call(context.Background(), "relay/configure", json.RawMessage(raw)); err == nil {
			t.Fatal("unsafe connector configuration was accepted")
		}
	}
}

func TestRelayConfigurationRequiresExplicitReadOnlyBoolean(t *testing.T) {
	for _, classification := range []string{"", `,"readOnly":null`, `,"readOnly":"false"`} {
		t.Run(classification, func(t *testing.T) {
			supervisor, writer := readyCodexSupervisor(t)
			supervisor.relayRoot = t.TempDir()
			config := relayFixtureConfiguration("22222222-2222-4222-8222-222222222222", 1, 1)
			raw, _ := json.Marshal(config)
			params := strings.Replace(string(raw), `,"readOnly":true`, classification, 1)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := supervisor.call(ctx, "relay/configure", json.RawMessage(params))
			if err == nil || !strings.Contains(err.Error(), "invalid connector") {
				t.Fatalf("expected malformed classification rejection, got %v", err)
			}
			if _, err := os.Stat(filepath.Join(supervisor.relayRoot, config.ConnectionID+".json")); !os.IsNotExist(err) {
				t.Fatal("malformed operation was persisted")
			}
			select {
			case <-writer.messages:
				t.Fatal("malformed operation reached the app server")
			default:
			}
		})
	}
}
