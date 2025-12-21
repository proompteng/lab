package orchestrator

import (
	"encoding/json"
	"sort"
	"time"
)

const (
	ideaStatusReceived      = "received"
	taskStateQueued         = "queued"
	taskRunStatusQueued     = "queued"
	attributeNamespace      = "facteur.codex.namespace"
	attributeWorkflow       = "facteur.codex.workflow"
	attributeDeliveryID     = "facteur.codex.delivery_id"
	attributeRepository     = "facteur.codex.repository"
	attributeIssueNumber    = "facteur.codex.issue_number"
	attributeDuplicate      = "facteur.codex.duplicate"
	attributePlanningStage  = "codex.stage"
	attributeArgoParameters = "facteur.codex.parameters"
)

type completedEntry struct {
	result    Result
	expiresAt time.Time
}

func cloneParameters(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func overrideStage(event []byte, stage string) ([]byte, error) {
	if len(event) == 0 {
		return event, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(event, &payload); err != nil {
		return nil, err
	}
	payload["stage"] = stage
	return json.Marshal(payload)
}
