package argo

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/client-go/rest"
)

func TestNewKubernetesClientForConfig(t *testing.T) {
	cfg := &rest.Config{
		Host: "https://127.0.0.1:6443",
		TLSClientConfig: rest.TLSClientConfig{
			Insecure: true,
		},
		APIPath: "/apis",
	}

	client, err := NewKubernetesClientForConfig(cfg)
	require.NoError(t, err)
	require.NotNil(t, client)

	_, err = NewKubernetesClientForConfig(nil)
	require.Error(t, err)
}

func TestBuildWorkflowMetadata(t *testing.T) {
	workflow, err := buildWorkflow(SubmitRequest{
		Namespace:        "argo",
		WorkflowTemplate: "facteur-dispatch",
		GenerateName:     "dispatch-",
		Parameters:       map[string]string{"target": "cluster-a"},
		Labels:           map[string]string{"codex.issue_number": "2238"},
		Annotations:      map[string]string{"codex.repository": "proompteng/lab"},
	})
	require.NoError(t, err)
	require.Equal(t, "argo", workflow.Namespace)
	require.Equal(t, "dispatch-", workflow.GenerateName)
	require.Equal(t, "facteur-dispatch", workflow.Spec.WorkflowTemplateRef.Name)
	require.Equal(t, map[string]string{"codex.issue_number": "2238"}, workflow.Labels)
	require.Equal(t, map[string]string{"codex.repository": "proompteng/lab"}, workflow.Annotations)
	require.Len(t, workflow.Spec.Arguments.Parameters, 1)
	require.Equal(t, "target", workflow.Spec.Arguments.Parameters[0].Name)
	require.NotNil(t, workflow.Spec.Arguments.Parameters[0].Value)
}
