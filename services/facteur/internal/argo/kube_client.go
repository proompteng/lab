package argo

import (
	"context"
	"fmt"
	"sort"

	apiv1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"

	"github.com/argoproj/argo-workflows/v3/pkg/apis/workflow/v1alpha1"
	argoclient "github.com/argoproj/argo-workflows/v3/pkg/client/clientset/versioned"
)

// KubernetesClient implements the Argo Client interface using the Kubernetes API.
type KubernetesClient struct {
	client argoclient.Interface
}

// NewKubernetesClientForConfig constructs a Kubernetes-backed Argo client from a REST config.
func NewKubernetesClientForConfig(cfg *rest.Config) (*KubernetesClient, error) {
	if cfg == nil {
		return nil, fmt.Errorf("argo: rest config is required")
	}

	cs, err := argoclient.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("argo: build clientset: %w", err)
	}

	return &KubernetesClient{client: cs}, nil
}

// SubmitWorkflow clones a WorkflowTemplate and creates a Workflow resource.
func (c *KubernetesClient) SubmitWorkflow(ctx context.Context, req SubmitRequest) (SubmitResponse, error) {
	workflow, err := buildWorkflow(req)
	if err != nil {
		return SubmitResponse{}, err
	}

	created, err := c.client.ArgoprojV1alpha1().Workflows(req.Namespace).Create(ctx, workflow, apiv1.CreateOptions{})
	if err != nil {
		return SubmitResponse{}, fmt.Errorf("argo: create workflow: %w", err)
	}

	workflowName := created.Name
	if workflowName == "" {
		workflowName = created.GenerateName
	}

	return SubmitResponse{Namespace: created.Namespace, WorkflowName: workflowName}, nil
}

// GetWorkflowTemplate retrieves template metadata and reports readiness.
func (c *KubernetesClient) GetWorkflowTemplate(ctx context.Context, namespace, name string) (TemplateStatus, error) {
	if namespace == "" {
		return TemplateStatus{}, fmt.Errorf("argo: namespace is required")
	}
	if name == "" {
		return TemplateStatus{}, fmt.Errorf("argo: workflow template name is required")
	}

	tmpl, err := c.client.ArgoprojV1alpha1().WorkflowTemplates(namespace).Get(ctx, name, apiv1.GetOptions{})
	if err != nil {
		return TemplateStatus{}, fmt.Errorf("argo: get workflow template: %w", err)
	}

	return TemplateStatus{Namespace: tmpl.Namespace, Name: tmpl.Name, Ready: true}, nil
}

func toParameterList(params map[string]string) []v1alpha1.Parameter {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	result := make([]v1alpha1.Parameter, 0, len(params))
	for _, key := range keys {
		value := params[key]
		result = append(result, v1alpha1.Parameter{Name: key, Value: v1alpha1.AnyStringPtr(value)})
	}
	return result
}

func buildWorkflow(req SubmitRequest) (*v1alpha1.Workflow, error) {
	if req.Namespace == "" {
		return nil, fmt.Errorf("argo: namespace is required")
	}
	if req.WorkflowTemplate == "" {
		return nil, fmt.Errorf("argo: workflow template is required")
	}
	if req.GenerateName == "" {
		return nil, fmt.Errorf("argo: generate name is required")
	}

	workflow := &v1alpha1.Workflow{
		ObjectMeta: apiv1.ObjectMeta{
			Namespace:    req.Namespace,
			GenerateName: req.GenerateName,
		},
		Spec: v1alpha1.WorkflowSpec{
			WorkflowTemplateRef: &v1alpha1.WorkflowTemplateRef{
				Name: req.WorkflowTemplate,
			},
		},
	}

	if len(req.Labels) > 0 {
		workflow.ObjectMeta.Labels = cloneMap(req.Labels)
	}

	if len(req.Annotations) > 0 {
		workflow.ObjectMeta.Annotations = cloneMap(req.Annotations)
	}

	if req.ServiceAccount != "" {
		workflow.Spec.ServiceAccountName = req.ServiceAccount
	}

	if len(req.Parameters) > 0 {
		workflow.Spec.Arguments.Parameters = toParameterList(req.Parameters)
	}

	return workflow, nil
}
