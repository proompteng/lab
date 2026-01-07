package orchestrator

import (
	"context"
	"time"

	"github.com/proompteng/lab/services/facteur/internal/knowledge"
)

// Config holds the settings needed to dispatch implementation workflows.
type Config struct {
	Namespace                    string
	AutonomousNamespace          string
	WorkflowTemplate             string
	AutonomousWorkflowTemplate   string
	ServiceAccount               string
	AutonomousServiceAccount     string
	Parameters                   map[string]string
	GenerateNamePrefix           string
	AutonomousGenerateNamePrefix string
	JudgePrompt                  string
}

// Result captures the outcome of a workflow submission.
type Result struct {
	Namespace    string
	WorkflowName string
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
