//go:build e2e

package e2e

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/proompteng/lab/services/facteur/internal/froussardpb"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestCodexIngestionEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping e2e test in short mode")
	}

	baseURL := strings.TrimSpace(os.Getenv("FACTEUR_E2E_BASE_URL"))
	if baseURL == "" {
		t.Skip("FACTEUR_E2E_BASE_URL not set")
	}
	dsn := strings.TrimSpace(os.Getenv("FACTEUR_E2E_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("FACTEUR_E2E_POSTGRES_DSN not set")
	}

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	deliveryID := fmt.Sprintf("delivery-%d", time.Now().UnixNano())
	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Prompt:      "Codex ingestion e2e",
		Repository:  "proompteng/lab",
		Base:        "main",
		Head:        "codex/e2e",
		IssueNumber: 1635,
		IssueUrl:    "https://github.com/proompteng/lab/issues/1635",
		IssueTitle:  "Codex: persist codex_kb intake for /codex/tasks",
		IssueBody:   "Check persistence path end-to-end.",
		Sender:      "codex-e2e",
		IssuedAt:    timestamppb.Now(),
		DeliveryId:  deliveryID,
	}

	payload, err := proto.Marshal(task)
	require.NoError(t, err)

	first := postCodexTask(t, client, baseURL, payload)
	require.False(t, first.Duplicate, "initial dispatch should not be marked as duplicate")

	db, err := sql.Open("pgx", dsn)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = db.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var persisted struct {
		RunID  string
		TaskID string
		IdeaID string
	}

	require.Eventually(t, func() bool {
		queryErr := db.QueryRowContext(ctx, `
			SELECT tr.id, tr.task_id, t.idea_id
			FROM codex_kb.task_runs tr
			JOIN codex_kb.tasks t ON tr.task_id = t.id
			WHERE tr.delivery_id = $1
		`, deliveryID).Scan(&persisted.RunID, &persisted.TaskID, &persisted.IdeaID)

		return queryErr == nil && persisted.RunID != "" && persisted.TaskID != "" && persisted.IdeaID != ""
	}, 30*time.Second, time.Second)

	second := postCodexTask(t, client, baseURL, payload)
	require.True(t, second.Duplicate, "idempotent replay should be marked as duplicate")
	require.Equal(t, first.Stage, second.Stage)
	require.Equal(t, first.Namespace, second.Namespace)
	require.Equal(t, first.WorkflowName, second.WorkflowName)
	require.Equal(t, first.SubmittedAt, second.SubmittedAt)

	var runCount int
	require.NoError(t, db.QueryRow(`
		SELECT COUNT(*) FROM codex_kb.task_runs WHERE delivery_id = $1
	`, deliveryID).Scan(&runCount))
	require.Equal(t, 1, runCount)
}

type codexResponse struct {
	Stage        string `json:"stage"`
	Namespace    string `json:"namespace"`
	WorkflowName string `json:"workflowName"`
	SubmittedAt  string `json:"submittedAt"`
	Duplicate    bool   `json:"duplicate"`
}

func postCodexTask(t *testing.T, client *http.Client, baseURL string, payload []byte) codexResponse {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	var lastStatus int
	var lastBody []byte
	var lastErr error

	for {
		req, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+"/codex/tasks", bytes.NewReader(payload))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/x-protobuf")

		resp, err := client.Do(req)
		if err == nil {
			bodyBytes, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			require.NoError(t, readErr)

			if resp.StatusCode == http.StatusAccepted {
				var body codexResponse
				require.NoError(t, json.Unmarshal(bodyBytes, &body))
				require.Equal(t, "implementation", body.Stage)
				require.NotEmpty(t, body.Namespace)
				require.NotEmpty(t, body.WorkflowName)
				require.NotEmpty(t, body.SubmittedAt)
				parsedAt, parseErr := time.Parse(time.RFC3339, body.SubmittedAt)
				require.NoError(t, parseErr)
				require.False(t, parsedAt.IsZero())
				return body
			}

			lastStatus = resp.StatusCode
			lastBody = bodyBytes
			lastErr = nil

			if resp.StatusCode != http.StatusServiceUnavailable {
				require.Failf(t, "unexpected response", "status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
			}
		} else {
			lastErr = err
		}

		if time.Now().After(deadline) {
			break
		}

		time.Sleep(1 * time.Second)
	}

	if lastErr != nil {
		require.Failf(t, "request failed", "error=%v", lastErr)
	}
	require.Failf(t, "service unavailable", "status=%d body=%s", lastStatus, strings.TrimSpace(string(lastBody)))
	return codexResponse{}
}
