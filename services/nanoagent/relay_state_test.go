package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func relayFixtureConfiguration(delegation string, recovery, generation uint64) relayConfiguration {
	return relayConfiguration{
		ConnectionID: "11111111-1111-4111-8111-111111111111",
		DelegationID: delegation, relayGeneration: relayGeneration{RecoveryGeneration: recovery, CredentialGeneration: generation},
		ConnectorID: "galactic", ClientService: "tengri-web",
		Binding:  relayBinding{Service: "tengri", ID: "44444444-4444-4444-8444-444444444444", Generation: "55555555-5555-4555-8555-555555555555"},
		Endpoint: "https://proompteng.ai/api/platform/relay/agent", Credential: strings.Repeat("a", 43),
		Operations: []relayOperation{{Name: "status", Description: "Read pod status", InputSchema: json.RawMessage(`{"type":"object"}`), ReadOnly: true}},
	}
}

func applyRelayControl(t *testing.T, supervisor *codexSupervisor, writer *codexWireWriter, method string, value any) json.RawMessage {
	t.Helper()
	params, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	type outcome struct {
		result codexCallResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() { result, err := supervisor.call(ctx, method, params); done <- outcome{result, err} }()
	for _, expected := range []string{"config/batchWrite", "config/mcpServer/reload"} {
		request := readCodexWireRequest(t, writer)
		if request.Method != expected {
			t.Fatalf("unexpected connector control method: %s", request.Method)
		}
		supervisor.resolveResponse(codexRPCMessage{ID: request.ID, Result: json.RawMessage(`{}`)})
	}
	completed := <-done
	if completed.err != nil {
		t.Fatal(completed.err)
	}
	return completed.result.result
}

func TestRelayGenerationsFenceDelayedConfigurationAndCleanupAcrossRestart(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	supervisor.relayRoot = t.TempDir()
	first := relayFixtureConfiguration("22222222-2222-4222-8222-222222222222", 1, 1)
	newer := relayFixtureConfiguration("33333333-3333-4333-8333-333333333333", 1, 3)
	applyRelayControl(t, supervisor, writer, "relay/configure", first)
	applyRelayControl(t, supervisor, writer, "relay/configure", newer)
	params, _ := json.Marshal(first)
	if _, err := supervisor.call(context.Background(), "relay/configure", params); err == nil {
		t.Fatal("accepted an installation older than the current credential")
	}
	cleanup, _ := json.Marshal(relayRemoval{ConnectionID: first.ConnectionID, DelegationID: first.DelegationID, relayGeneration: first.relayGeneration})
	if _, err := supervisor.call(context.Background(), "relay/remove", cleanup); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(supervisor.relayRoot, first.ConnectionID+".json")
	raw, _ := os.ReadFile(file)
	if !strings.Contains(string(raw), newer.DelegationID) {
		t.Fatal("delayed cleanup removed the newer credential")
	}
	select {
	case <-writer.messages:
		t.Fatal("stale configuration or cleanup reached the app server")
	default:
	}
	removal := relayRemoval{ConnectionID: first.ConnectionID, relayGeneration: relayGeneration{RecoveryGeneration: 1, CredentialGeneration: 4}}
	applyRelayControl(t, supervisor, writer, "relay/remove", removal)
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("revocation retained a credential file")
	}
	installed, err := relayInstallations(supervisor.relayRoot)
	if err != nil || len(installed) != 0 {
		t.Fatal("revocation still advertises installed tools")
	}
	restarted := newCodexSupervisor("/usr/bin/false", t.TempDir())
	t.Cleanup(restarted.close)
	restarted.relayRoot = supervisor.relayRoot
	params, _ = json.Marshal(newer)
	if _, err := restarted.call(context.Background(), "relay/configure", params); err == nil {
		t.Fatal("restart forgot the removal tombstone")
	}
	recovered := relayFixtureConfiguration("66666666-6666-4666-8666-666666666666", 2, 1)
	applyRelayControl(t, supervisor, writer, "relay/configure", recovered)
	removal.CredentialGeneration = 1000
	params, _ = json.Marshal(removal)
	if _, err := supervisor.call(context.Background(), "relay/remove", params); err != nil {
		t.Fatal(err)
	}
	installed, err = relayInstallations(supervisor.relayRoot)
	if err != nil || len(installed) != 1 || !installed[0].Configured || installed[0].RecoveryGeneration != 2 {
		t.Fatal("an old recovery epoch changed the current installation")
	}
	select {
	case <-writer.messages:
		t.Fatal("old recovery cleanup reached the app server")
	default:
	}
}

func TestRelayAcknowledgementRequiresTheAppServerRefreshToComplete(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	supervisor.relayRoot = t.TempDir()
	config := relayFixtureConfiguration("22222222-2222-4222-8222-222222222222", 1, 1)
	params, _ := json.Marshal(config)
	done := make(chan error, 1)
	go func() { _, err := supervisor.call(context.Background(), "relay/configure", params); done <- err }()
	write := readCodexWireRequest(t, writer)
	supervisor.resolveResponse(codexRPCMessage{ID: write.ID, Result: json.RawMessage(`{}`)})
	reload := readCodexWireRequest(t, writer)
	supervisor.resolveResponse(codexRPCMessage{ID: reload.ID, Error: json.RawMessage(`{"code":-32000,"message":"fixture refresh failed"}`)})
	if err := <-done; err == nil {
		t.Fatal("acknowledged a failed tool refresh")
	}
	installed, err := relayInstallations(supervisor.relayRoot)
	if err != nil || len(installed) != 1 || installed[0].Configured {
		t.Fatal("a partial installation was advertised as configured")
	}
	applyRelayControl(t, supervisor, writer, "relay/configure", config)
	installed, err = relayInstallations(supervisor.relayRoot)
	if err != nil || !installed[0].Configured {
		t.Fatal("the same installation could not recover after a failed refresh")
	}
	metadata, _ := json.Marshal(installed)
	if strings.Contains(string(metadata), config.Credential) || strings.Contains(string(metadata), "PRIVATE") {
		t.Fatal("installation metadata exposed a private credential")
	}
}

func TestRelayStateRejectsSymlinksPublicFilesAndSpecialFiles(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "state")
	if err := os.WriteFile(file, []byte(`{}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := relayPrivateFile(file, 16384); err == nil {
		t.Fatal("accepted public connector state")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if _, err := relayPrivateFile(link, 16384); err == nil {
		t.Fatal("followed a connector state symlink")
	}
	fifo := filepath.Join(root, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := relayPrivateFile(fifo, 16384); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("accepted a connector state FIFO")
		}
	case <-time.After(time.Second):
		t.Fatal("opening a connector state FIFO blocked")
	}
}
