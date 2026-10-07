package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

// This stdio adapter owns no third-party credentials or provider endpoints.
// Its only peer is Relay, authenticated using the guest's rotating workload identity.
func runRelayMCP(input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	source, err := workloadapi.NewX509Source(ctx, workloadapi.WithClientOptions(workloadapi.WithAddr("unix://"+spireRuntimeDirectory+"/agent.sock")))
	if err != nil {
		return err
	}
	defer source.Close()
	svid, err := source.GetX509SVID()
	if err != nil {
		return err
	}
	peer, err := spiffeid.FromPath(svid.ID.TrustDomain(), "/ns/relay/sa/relay")
	if err != nil {
		return err
	}
	transport := &http.Transport{TLSClientConfig: tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(peer)), ForceAttemptHTTP2: true, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 70 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("Relay redirect rejected") }}
	return relayStdio(input, output, client, "https://relay.relay.svc.cluster.local:8443/mcp")
}

func relayStdio(input io.Reader, output io.Writer, client *http.Client, endpoint string) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var message struct {
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Version string          `json:"jsonrpc"`
		}
		if err := json.Unmarshal(line, &message); err != nil || message.Version != "2.0" {
			return errors.New("invalid MCP request")
		}
		request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(line))
		if err != nil {
			return err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json")
		response, err := client.Do(request)
		if err != nil {
			if len(message.ID) == 0 {
				continue
			}
			if err := relayTransportError(encoder, message.ID); err != nil {
				return err
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
		response.Body.Close()
		if len(message.ID) == 0 {
			continue
		}
		if readErr != nil || len(body) > 2<<20 || response.StatusCode != http.StatusOK || !json.Valid(body) {
			if err := relayTransportError(encoder, message.ID); err != nil {
				return err
			}
			continue
		}
		var result struct {
			ID      json.RawMessage `json:"id"`
			Version string          `json:"jsonrpc"`
		}
		if err := json.Unmarshal(body, &result); err != nil || result.Version != "2.0" || !bytes.Equal(bytes.TrimSpace(result.ID), bytes.TrimSpace(message.ID)) {
			if err := relayTransportError(encoder, message.ID); err != nil {
				return err
			}
			continue
		}
		if _, err := fmt.Fprintf(output, "%s\n", body); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func relayTransportError(encoder *json.Encoder, id json.RawMessage) error {
	return encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32000, "message": "Relay transport unavailable"}})
}
