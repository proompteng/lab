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
	supervisor.connectorsEnabled = true
	supervisor.relayRoot = t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := "11111111-1111-4111-8111-111111111111"
	credential := strings.Repeat("a", 43)
	params, _ := json.Marshal(relayConfiguration{ConnectionID: connection, Endpoint: "https://proompteng.ai/api/tengri/connectors/agent", GrantID: "22222222-2222-4222-8222-222222222222", Credential: credential, Operations: []relayOperation{{Name: "search", Description: "Search issues", InputSchema: json.RawMessage(`{"type":"object"}`)}}})
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
	go func() {
		_, err := supervisor.call(ctx, "relay/remove", json.RawMessage(`{"connectionId":"11111111-1111-4111-8111-111111111111"}`))
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
	supervisor.connectorsEnabled = true
	supervisor.relayRoot = t.TempDir()
	for _, raw := range []string{
		`{"connectionId":"../../escape"}`,
		`{"connectionId":"11111111-1111-4111-8111-111111111111","keyFile":"/etc/shadow"}`,
		`{"connectionId":"11111111-1111-4111-8111-111111111111","endpoint":"http://insecure.example","credential":"a"}`,
		`{"connectionId":"11111111-1111-4111-8111-111111111111","arbitraryCommand":"sh"}`,
	} {
		if _, err := supervisor.call(context.Background(), "relay/configure", json.RawMessage(raw)); err == nil {
			t.Fatal("unsafe connector configuration was accepted")
		}
	}
}

func TestRelayIsDormantBeforeWritingIdentityOrConfiguration(t *testing.T) {
	for _, setting := range []string{"", "false", "1", "TRUE", "true "} {
		t.Run(setting, func(t *testing.T) {
			t.Setenv("TENGRI_CONNECTORS_ENABLED", setting)
			supervisor := newCodexSupervisor("/usr/bin/false", t.TempDir())
			supervisor.relayRoot = filepath.Join(t.TempDir(), "uncreated")
			for _, method := range []string{"relay/identity", "relay/configure", "relay/remove"} {
				if _, err := supervisor.call(context.Background(), method, json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not enabled") {
					t.Fatalf("%s did not stop at the dormant gate: %v", method, err)
				}
			}
			if _, err := os.Stat(supervisor.relayRoot); !os.IsNotExist(err) {
				t.Fatalf("disabled connector created identity/configuration state: %v", err)
			}
		})
	}
}
