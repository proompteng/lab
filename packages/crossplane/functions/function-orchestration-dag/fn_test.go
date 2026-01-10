package main

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunction_BuildsDagTasks(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "dag"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "OrchestrationDag",
			"spec": {
				"stepsFieldPath": "spec.steps",
				"entrypointFieldPath": "spec.entrypoint",
				"targetWorkflowTemplate": "workflow"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "Orchestration",
					"spec": {
						"entrypoint": "main",
						"steps": [
							{
								"name": "step-one",
								"kind": "AgentRun",
								"agentRef": "agent-template",
								"with": {
									"prompt": "hello",
									"count": 2
								}
							},
						{
							"name": "step-two",
							"kind": "ToolRun",
							"toolRef": "tool-template",
							"dependsOn": ["step-one"]
						},
						{
							"name": "step-three",
							"kind": "ApprovalGate",
							"policyRef": "approval-policy",
							"dependsOn": ["step-two"]
						},
						{
							"name": "step-four",
							"kind": "SignalWait",
							"dependsOn": ["step-three"]
						}
					]
				}
			}`),
			},
			Resources: map[string]*fnv1.Resource{
				"workflow": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "argoproj.io/v1alpha1",
						"kind": "WorkflowTemplate",
						"spec": {
							"templates": [
								{
									"name": "main",
									"dag": {
										"tasks": []
									}
								},
								{
									"name": "sidecar"
								}
							]
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

	template := desiredTemplate(t, rsp, "workflow", "main")
	tasks := taskMap(t, template)

	stepOne := tasks["step-one"]
	if stepOne == nil {
		t.Fatalf("step-one task missing")
	}
	templateRef, _ := stepOne["templateRef"].(map[string]any)
	if diff := cmp.Diff(map[string]any{"name": "agent-template", "template": "agent-run"}, templateRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("step-one templateRef mismatch (-want +got):\n%s", diff)
	}
	parameters := paramMap(t, stepOne)
	if diff := cmp.Diff(map[string]string{"prompt": "hello", "count": "2"}, parameters); diff != "" {
		t.Fatalf("step-one parameters mismatch (-want +got):\n%s", diff)
	}

	stepTwo := tasks["step-two"]
	if stepTwo == nil {
		t.Fatalf("step-two task missing")
	}
	deps := stringSlice(stepTwo["dependencies"])
	if diff := cmp.Diff([]string{"step-one"}, deps); diff != "" {
		t.Fatalf("step-two dependencies mismatch (-want +got):\n%s", diff)
	}
	templateRef, _ = stepTwo["templateRef"].(map[string]any)
	if diff := cmp.Diff(map[string]any{"name": "tool-template", "template": "run"}, templateRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("step-two templateRef mismatch (-want +got):\n%s", diff)
	}
	parameters = paramMap(t, stepTwo)
	if diff := cmp.Diff(map[string]string{"toolRef": "tool-template"}, parameters); diff != "" {
		t.Fatalf("step-two parameters mismatch (-want +got):\n%s", diff)
	}

	stepThree := tasks["step-three"]
	if stepThree == nil {
		t.Fatalf("step-three task missing")
	}
	templateRef, _ = stepThree["templateRef"].(map[string]any)
	if diff := cmp.Diff(map[string]any{"name": "jangar-approval-gate", "template": "gate"}, templateRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("step-three templateRef mismatch (-want +got):\n%s", diff)
	}
	parameters = paramMap(t, stepThree)
	if diff := cmp.Diff(map[string]string{"policyRef": "approval-policy"}, parameters); diff != "" {
		t.Fatalf("step-three parameters mismatch (-want +got):\n%s", diff)
	}

	stepFour := tasks["step-four"]
	if stepFour == nil {
		t.Fatalf("step-four task missing")
	}
	templateRef, _ = stepFour["templateRef"].(map[string]any)
	if diff := cmp.Diff(map[string]any{"name": "jangar-signal-wait", "template": "wait"}, templateRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("step-four templateRef mismatch (-want +got):\n%s", diff)
	}
}

func TestRunFunction_ObservedFallback(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "observed-fallback"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "OrchestrationDag",
			"spec": {
				"stepsFieldPath": "spec.steps",
				"entrypointFieldPath": "spec.entrypoint",
				"targetWorkflowTemplate": "workflow"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "Orchestration",
					"spec": {}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"workflow": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "argoproj.io/v1alpha1",
						"kind": "WorkflowTemplate",
						"spec": {
							"templates": [
								{
									"name": "main",
									"dag": {
										"tasks": []
									}
								}
							]
						}
					}`),
				},
			},
		},
		Observed: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "Orchestration",
					"spec": {
						"entrypoint": "main",
						"steps": [
							{
								"name": "step-one",
								"kind": "SignalWait"
							}
						]
					}
				}`),
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	template := desiredTemplate(t, rsp, "workflow", "main")
	tasks := taskMap(t, template)
	if _, ok := tasks["step-one"]; !ok {
		t.Fatalf("expected step-one task from observed spec")
	}
}

func TestRunFunction_MissingEntrypointTemplate(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "missing-entrypoint"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "OrchestrationDag",
			"spec": {
				"stepsFieldPath": "spec.steps",
				"entrypointFieldPath": "spec.entrypoint",
				"targetWorkflowTemplate": "workflow"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "orchestration.proompteng.ai/v1alpha1",
					"kind": "Orchestration",
					"spec": {
						"entrypoint": "main",
						"steps": []
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"workflow": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "argoproj.io/v1alpha1",
						"kind": "WorkflowTemplate",
						"spec": {
							"templates": [
								{ "name": "other" }
							]
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

	if len(rsp.GetResults()) == 0 || rsp.GetResults()[0].GetSeverity() != fnv1.Severity_SEVERITY_FATAL {
		t.Fatalf("expected fatal result when entrypoint missing")
	}
	if msg := rsp.GetResults()[0].GetMessage(); !strings.Contains(msg, "entrypoint template") {
		t.Fatalf("unexpected fatal message: %q", msg)
	}
}

func desiredTemplate(t *testing.T, rsp *fnv1.RunFunctionResponse, resourceName, templateName string) map[string]any {
	t.Helper()

	res := rsp.GetDesired().GetResources()[resourceName]
	if res == nil {
		t.Fatalf("desired resource %q not found", resourceName)
	}

	obj := &unstructured.Unstructured{}
	if err := resource.AsObject(res.GetResource(), obj); err != nil {
		t.Fatalf("decoding desired resource %q: %v", resourceName, err)
	}

	templates, found, err := unstructured.NestedSlice(obj.Object, "spec", "templates")
	if err != nil || !found {
		t.Fatalf("spec.templates missing: %v", err)
	}

	for _, tplRaw := range templates {
		tpl, ok := tplRaw.(map[string]any)
		if !ok {
			continue
		}
		if name, _ := tpl["name"].(string); name == templateName {
			return tpl
		}
	}

	t.Fatalf("template %q not found", templateName)
	return nil
}

func taskMap(t *testing.T, template map[string]any) map[string]map[string]any {
	t.Helper()

	tasksRaw, found, err := unstructured.NestedSlice(template, "dag", "tasks")
	if err != nil || !found {
		t.Fatalf("dag.tasks missing: %v", err)
	}

	out := make(map[string]map[string]any, len(tasksRaw))
	for _, taskRaw := range tasksRaw {
		task, ok := taskRaw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := task["name"].(string)
		if name != "" {
			out[name] = task
		}
	}

	return out
}

func paramMap(t *testing.T, task map[string]any) map[string]string {
	t.Helper()

	args, _ := task["arguments"].(map[string]any)
	paramsRaw, _ := args["parameters"].([]any)
	out := make(map[string]string, len(paramsRaw))
	for _, item := range paramsRaw {
		param, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := param["name"].(string)
		value, _ := param["value"].(string)
		if name != "" {
			out[name] = value
		}
	}
	return out
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
