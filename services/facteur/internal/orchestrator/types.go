package orchestrator

import (
	"context"
	"time"

	"github.com/proompteng/lab/services/facteur/internal/knowledge"
)

// Config holds the settings needed to dispatch implementation workflows.
type Config struct {
	Namespace               string
	AgentName               string
	RuntimeType             string
	RuntimeConfig           map[string]any
	Parameters              map[string]string
	Secrets                 []string
	SecretBindingRef        string
	VCSProvider             string
	VCSPolicyMode           string
	VCSRequired             bool
	GoalTokenBudget         int
	TTLSecondsAfterFinished int
}

// Result captures the outcome of an AgentRun submission.
type Result struct {
	Namespace    string
	AgentRunName string
	SubmittedAt  time.Time
	Duplicate    bool
}

type knowledgeStore interface {
	UpsertIdea(ctx context.Context, record knowledge.IdeaRecord) (string, error)
	RecordTaskLifecycle(
		ctx context.Context,
		task knowledge.TaskRecord,
		run knowledge.TaskRunRecord,
	) (knowledge.TaskRecord, knowledge.TaskRunRecord, error)
}

type requestState struct {
	done   chan struct{}
	result Result
	err    error
}
