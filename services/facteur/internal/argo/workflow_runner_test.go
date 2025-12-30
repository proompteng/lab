package argo_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/argo"
)

func TestWorkflowRunnerRun(t *testing.T) {
	client := &fakeClient{}
	runner := argo.NewWorkflowRunner(client).WithClock(fakeClock{now: time.Date(2025, time.April, 22, 15, 4, 5, 0, time.UTC)})

	input := argo.RunInput{
		Namespace:          "argo",
		WorkflowTemplate:   "facteur-dispatch",
		ServiceAccount:     "facteur",
		Parameters:         map[string]string{"target": "cluster-a"},
		Labels:             map[string]string{"codex.issue_number": "1234"},
		Annotations:        map[string]string{"codex.repository": "proompteng/lab"},
		GenerateNamePrefix: "dispatch",
	}

	client.response = argo.SubmitResponse{Namespace: "argo", WorkflowName: "dispatch-20250422-150405-abcd"}

	result, err := runner.Run(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, "argo", result.Namespace)
	require.Equal(t, "dispatch-20250422-150405-abcd", result.WorkflowName)
	require.Equal(t, time.Date(2025, time.April, 22, 15, 4, 5, 0, time.UTC), result.SubmittedAt)

	require.True(t, client.submitCalled)
	require.Equal(t, "argo", client.lastRequest.Namespace)
	require.Equal(t, "facteur-dispatch", client.lastRequest.WorkflowTemplate)
	require.Equal(t, "facteur", client.lastRequest.ServiceAccount)
	require.Equal(t, map[string]string{"target": "cluster-a"}, client.lastRequest.Parameters)
	require.Equal(t, map[string]string{"codex.issue_number": "1234"}, client.lastRequest.Labels)
	require.Equal(t, map[string]string{"codex.repository": "proompteng/lab"}, client.lastRequest.Annotations)
	require.Equal(t, "dispatch-20250422-150405-", client.lastRequest.GenerateName)
}

func TestWorkflowRunnerRunValidation(t *testing.T) {
	runner := argo.NewWorkflowRunner(&fakeClient{})

	_, err := runner.Run(context.Background(), argo.RunInput{WorkflowTemplate: "template"})
	require.Error(t, err)
	_, err = runner.Run(context.Background(), argo.RunInput{Namespace: "argo"})
	require.Error(t, err)
}

func TestWorkflowRunnerTemplateStatus(t *testing.T) {
	client := &fakeClient{templateStatus: argo.TemplateStatus{Name: "facteur-dispatch", Namespace: "argo", Ready: true}}
	runner := argo.NewWorkflowRunner(client)

	status, err := runner.TemplateStatus(context.Background(), "argo", "facteur-dispatch")
	require.NoError(t, err)
	require.True(t, client.templateCalled)
	require.Equal(t, "facteur-dispatch", status.Name)
	require.True(t, status.Ready)
}

type fakeClient struct {
	submitCalled   bool
	templateCalled bool
	lastRequest    argo.SubmitRequest
	response       argo.SubmitResponse
	templateStatus argo.TemplateStatus
	submitErr      error
	templateErr    error
}

func (f *fakeClient) SubmitWorkflow(_ context.Context, req argo.SubmitRequest) (argo.SubmitResponse, error) {
	f.submitCalled = true
	f.lastRequest = req
	if f.submitErr != nil {
		return argo.SubmitResponse{}, f.submitErr
	}
	return f.response, nil
}

func (f *fakeClient) GetWorkflowTemplate(context.Context, string, string) (argo.TemplateStatus, error) {
	f.templateCalled = true
	if f.templateErr != nil {
		return argo.TemplateStatus{}, f.templateErr
	}
	return f.templateStatus, nil
}

type fakeClock struct{ now time.Time }

func (f fakeClock) Now() time.Time { return f.now }
