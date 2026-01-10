package main

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunction_MapsStepStatuses(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "step-statuses"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "OrchestrationStatus",
			"spec": {
				"workflowResource": "workflow",
				"stepStatusesFieldPath": "status.stepStatuses"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "OrchestrationRun",
					"status": {}
				}`),
			},
		},
		Observed: &fnv1.State{
			Resources: map[string]*fnv1.Resource{
				"workflow": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "argoproj.io/v1alpha1",
						"kind": "Workflow",
						"status": {
							"nodes": {
								"node-main": {
									"displayName": "main",
									"type": "DAG",
									"phase": "Succeeded"
								},
								"node-step-one": {
									"displayName": "step-one",
									"type": "Pod",
									"phase": "Succeeded",
									"startedAt": "2026-01-10T00:00:00Z",
									"finishedAt": "2026-01-10T00:01:00Z"
								},
								"node-approval": {
									"displayName": "approval",
									"type": "Suspend",
									"phase": "Running"
								},
								"node-step-two": {
									"name": "step-two",
									"type": "Pod",
									"phase": "Failed"
								}
							}
						}
					}`),
				},
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	statuses := desiredStepStatuses(t, rsp)
	if diff := cmp.Diff([]map[string]any{
		{"name": "approval", "phase": "Running", "startedAt": "", "finishedAt": ""},
		{"name": "step-one", "phase": "Succeeded", "startedAt": "2026-01-10T00:00:00Z", "finishedAt": "2026-01-10T00:01:00Z"},
		{"name": "step-two", "phase": "Failed", "startedAt": "", "finishedAt": ""},
	}, statuses, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("step statuses mismatch (-want +got):\n%s", diff)
	}
}

func TestRunFunction_EmptyWhenWorkflowMissing(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "empty-status"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "OrchestrationStatus",
			"spec": {
				"workflowResource": "workflow",
				"stepStatusesFieldPath": "status.stepStatuses"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "OrchestrationRun",
					"status": {}
				}`),
			},
		},
		Observed: &fnv1.State{},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	statuses := desiredStepStatuses(t, rsp)
	if diff := cmp.Diff([]map[string]any{}, statuses, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("expected empty statuses (-want +got):\n%s", diff)
	}
}

func desiredStepStatuses(t *testing.T, rsp *fnv1.RunFunctionResponse) []map[string]any {
	t.Helper()

	res := rsp.GetDesired().GetComposite()
	if res == nil {
		t.Fatalf("desired composite missing")
	}

	obj := &unstructured.Unstructured{}
	if err := resource.AsObject(res.GetResource(), obj); err != nil {
		t.Fatalf("decoding desired composite: %v", err)
	}

	items, found, err := unstructured.NestedSlice(obj.Object, "status", "stepStatuses")
	if err != nil || !found {
		return nil
	}

	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		status, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, status)
	}

	return out
}
