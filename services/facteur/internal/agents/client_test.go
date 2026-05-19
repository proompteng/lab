package agents

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHTTPSubmitterCreatesAgentRun(t *testing.T) {
	var capturedPath string
	var capturedIdempotencyKey string
	var capturedPayload map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedIdempotencyKey = r.Header.Get("idempotency-key")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&capturedPayload))
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"resource":{"metadata":{"namespace":"agents","name":"codex-agent-abc123"}}}`))
	}))
	defer server.Close()

	submitter, err := NewHTTPSubmitter(server.URL, server.Client())
	require.NoError(t, err)
	submitter.now = func() time.Time { return time.Unix(1735600400, 0).UTC() }

	result, err := submitter.SubmitAgentRun(t.Context(), SubmitAgentRunInput{
		Namespace:               "agents",
		AgentName:               "codex-agent",
		DeliveryID:              "delivery-1",
		GoalObjective:           "ship it",
		GoalTokenBudget:         4096,
		RuntimeType:             "job",
		RuntimeConfig:           map[string]any{"serviceAccount": "agents-runner"},
		Secrets:                 []string{"github-token", "codex-auth"},
		SecretBindingRef:        "codex-github-token",
		VCSProvider:             "github",
		VCSPolicyMode:           "read-write",
		VCSRequired:             true,
		TTLSecondsAfterFinished: 86400,
		Implementation: map[string]any{
			"summary": "Implement issue",
			"text":    "Implement the requested work.",
		},
		Parameters: map[string]string{
			"repository":  "proompteng/lab",
			"issueNumber": "7152",
		},
	})
	require.NoError(t, err)

	require.Equal(t, "/v1/agent-runs", capturedPath)
	require.Equal(t, "delivery-1", capturedIdempotencyKey)
	require.Equal(t, "agents", capturedPayload["namespace"])
	require.Equal(t, "codex-agent", capturedPayload["agentRef"].(map[string]any)["name"])
	require.Equal(t, "job", capturedPayload["runtime"].(map[string]any)["type"])
	require.Equal(t, "agents-runner", capturedPayload["runtime"].(map[string]any)["config"].(map[string]any)["serviceAccount"])
	require.Equal(t, "github", capturedPayload["vcsRef"].(map[string]any)["name"])
	require.Equal(t, "read-write", capturedPayload["vcsPolicy"].(map[string]any)["mode"])
	require.Equal(t, true, capturedPayload["vcsPolicy"].(map[string]any)["required"])
	require.Equal(t, "codex-github-token", capturedPayload["policy"].(map[string]any)["secretBindingRef"])
	require.Equal(t, []any{"github-token", "codex-auth"}, capturedPayload["secrets"])
	require.Equal(t, "ship it", capturedPayload["goal"].(map[string]any)["objective"])
	require.Equal(t, float64(4096), capturedPayload["goal"].(map[string]any)["tokenBudget"])
	require.Equal(t, float64(86400), capturedPayload["ttlSecondsAfterFinished"])
	require.Equal(t, "Implement the requested work.", capturedPayload["implementation"].(map[string]any)["text"])
	require.Equal(t, "proompteng/lab", capturedPayload["parameters"].(map[string]any)["repository"])
	require.Equal(t, "7152", capturedPayload["parameters"].(map[string]any)["issueNumber"])
	require.Equal(t, "agents", result.Namespace)
	require.Equal(t, "codex-agent-abc123", result.AgentRunName)
	require.Equal(t, time.Unix(1735600400, 0).UTC(), result.SubmittedAt)
}

func TestHTTPSubmitterReturnsAgentsErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"secretBindingRef is required"}`))
	}))
	defer server.Close()

	submitter, err := NewHTTPSubmitter(server.URL, server.Client())
	require.NoError(t, err)

	_, err = submitter.SubmitAgentRun(t.Context(), SubmitAgentRunInput{
		Namespace:      "agents",
		AgentName:      "codex-agent",
		DeliveryID:     "delivery-2",
		RuntimeType:    "job",
		Implementation: map[string]any{"text": "Implement."},
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "status=403")
	require.ErrorContains(t, err, "secretBindingRef is required")
}

func TestHTTPSubmitterAcceptsExistingAgentRunResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "delivery-existing", r.Header.Get("idempotency-key"))
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"existingAgentRunName":"codex-agent-existing"}`))
	}))
	defer server.Close()

	submitter, err := NewHTTPSubmitter(server.URL, server.Client())
	require.NoError(t, err)

	result, err := submitter.SubmitAgentRun(t.Context(), SubmitAgentRunInput{
		Namespace:      "agents",
		AgentName:      "codex-agent",
		DeliveryID:     "delivery-existing",
		RuntimeType:    "job",
		Implementation: map[string]any{"text": "Implement."},
	})
	require.NoError(t, err)
	require.Equal(t, "agents", result.Namespace)
	require.Equal(t, "codex-agent-existing", result.AgentRunName)
}
