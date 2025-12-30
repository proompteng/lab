package argo

import (
	"context"
	"fmt"
	"time"
)

// Runner exposes workflow submission and template inspection utilities.
type Runner interface {
	Run(ctx context.Context, input RunInput) (RunResult, error)
	TemplateStatus(ctx context.Context, namespace, template string) (TemplateStatus, error)
}

// WorkflowRunner implements Runner using an Argo client.
type WorkflowRunner struct {
	client Client
	clock  Clock
}

// RunInput describes a workflow submission request.
type RunInput struct {
	Namespace          string
	WorkflowTemplate   string
	ServiceAccount     string
	Parameters         map[string]string
	Labels             map[string]string
	Annotations        map[string]string
	GenerateNamePrefix string
}

// RunResult captures submission metadata.
type RunResult struct {
	Namespace    string
	WorkflowName string
	SubmittedAt  time.Time
}

// Clock abstracts time for deterministic testing.
type Clock interface {
	Now() time.Time
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

// NewWorkflowRunner builds a WorkflowRunner with the real clock.
func NewWorkflowRunner(client Client) *WorkflowRunner {
	return &WorkflowRunner{client: client, clock: systemClock{}}
}

// WithClock overrides the clock for tests.
func (r *WorkflowRunner) WithClock(clock Clock) *WorkflowRunner {
	r.clock = clock
	return r
}

// Run submits a workflow cloned from a WorkflowTemplate.
func (r *WorkflowRunner) Run(ctx context.Context, input RunInput) (RunResult, error) {
	if input.Namespace == "" {
		return RunResult{}, fmt.Errorf("argo: namespace is required")
	}
	if input.WorkflowTemplate == "" {
		return RunResult{}, fmt.Errorf("argo: workflow template is required")
	}

	generateName := ensureGenerateName(input.GenerateNamePrefix, input.WorkflowTemplate, r.clock.Now())

	req := SubmitRequest{
		Namespace:        input.Namespace,
		WorkflowTemplate: input.WorkflowTemplate,
		ServiceAccount:   input.ServiceAccount,
		GenerateName:     generateName,
		Parameters:       cloneMap(input.Parameters),
		Labels:           cloneMap(input.Labels),
		Annotations:      cloneMap(input.Annotations),
	}

	resp, err := r.client.SubmitWorkflow(ctx, req)
	if err != nil {
		return RunResult{}, fmt.Errorf("argo: submit workflow: %w", err)
	}

	return RunResult{Namespace: resp.Namespace, WorkflowName: resp.WorkflowName, SubmittedAt: r.clock.Now()}, nil
}

// TemplateStatus fetches readiness details for a WorkflowTemplate.
func (r *WorkflowRunner) TemplateStatus(ctx context.Context, namespace, template string) (TemplateStatus, error) {
	status, err := r.client.GetWorkflowTemplate(ctx, namespace, template)
	if err != nil {
		return TemplateStatus{}, fmt.Errorf("argo: get workflow template: %w", err)
	}
	return status, nil
}

func ensureGenerateName(prefix, template string, now time.Time) string {
	if prefix == "" {
		prefix = template
	}

	timestamp := now.Format("20060102-150405")
	if prefix[len(prefix)-1] != '-' {
		prefix += "-"
	}

	return fmt.Sprintf("%s%s-", prefix, timestamp)
}

func cloneMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}

	clone := make(map[string]string, len(input))
	for k, v := range input {
		clone[k] = v
	}
	return clone
}
