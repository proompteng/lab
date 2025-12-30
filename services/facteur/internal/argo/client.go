package argo

import "context"

// SubmitRequest captures the parameters used to clone a WorkflowTemplate and submit a workflow.
type SubmitRequest struct {
	Namespace        string
	WorkflowTemplate string
	ServiceAccount   string
	GenerateName     string
	Parameters       map[string]string
	Labels           map[string]string
	Annotations      map[string]string
}

// SubmitResponse is returned after a workflow submission.
type SubmitResponse struct {
	Namespace    string
	WorkflowName string
}

// TemplateStatus describes the readiness of a WorkflowTemplate.
type TemplateStatus struct {
	Namespace string
	Name      string
	Ready     bool
}

// Client represents the minimal Argo Workflows API surface required by facteur.
type Client interface {
	SubmitWorkflow(ctx context.Context, req SubmitRequest) (SubmitResponse, error)
	GetWorkflowTemplate(ctx context.Context, namespace, name string) (TemplateStatus, error)
}
