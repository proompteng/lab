package main

import (
	"context"
	"fmt"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-orchestration-dag/input/v1alpha1"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
)

// Function builds Argo DAG tasks for orchestration resources.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

type orchestrationStep struct {
	Name      string
	Kind      string
	DependsOn []string
	AgentRef  string
	ToolRef   string
	MemoryRef string
	PolicyRef string
	With      map[string]any
}

// RunFunction runs the Function.
//
//nolint:gocognit // Composition orchestration requires multiple guard clauses and branches.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.OrchestrationDag{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.StepsFieldPath == "" || in.Spec.TargetWorkflowTemplate == "" || in.Spec.EntrypointFieldPath == "" {
		response.Fatal(rsp, errors.New("spec.stepsFieldPath, spec.entrypointFieldPath, and spec.targetWorkflowTemplate are required"))
		return rsp, nil
	}

	xr, err := request.GetDesiredCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composite resource"))
		return rsp, nil
	}

	observedXR, _ := request.GetObservedCompositeResource(req)

	dcds, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return rsp, nil
	}

	entrypointRaw, err := fieldpath.Pave(xr.Resource.Object).GetValue(in.Spec.EntrypointFieldPath)
	if err != nil && observedXR != nil {
		entrypointRaw, err = fieldpath.Pave(observedXR.Resource.Object).GetValue(in.Spec.EntrypointFieldPath)
	}
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read entrypoint"))
		return rsp, nil
	}
	entrypoint, _ := entrypointRaw.(string)
	if entrypoint == "" {
		response.Fatal(rsp, errors.New("entrypoint is required"))
		return rsp, nil
	}

	stepsRaw, err := fieldpath.Pave(xr.Resource.Object).GetValue(in.Spec.StepsFieldPath)
	if err != nil && observedXR != nil {
		stepsRaw, err = fieldpath.Pave(observedXR.Resource.Object).GetValue(in.Spec.StepsFieldPath)
	}
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read steps"))
		return rsp, nil
	}

	steps, err := parseSteps(stepsRaw)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "invalid steps"))
		return rsp, nil
	}

	target, ok := dcds[resource.Name(in.Spec.TargetWorkflowTemplate)]
	if !ok {
		response.Fatal(rsp, errors.Errorf("desired resource %q not found", in.Spec.TargetWorkflowTemplate))
		return rsp, nil
	}

	templates, found, err := unstructured.NestedSlice(target.Resource.Object, "spec", "templates")
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read workflow templates"))
		return rsp, err
	}
	if !found || len(templates) == 0 {
		response.Fatal(rsp, errors.New("workflow template missing spec.templates"))
		return rsp, nil
	}

	templateIndex := -1
	for i, tplRaw := range templates {
		tpl, ok := tplRaw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := tpl["name"].(string)
		if name == entrypoint {
			templateIndex = i
			break
		}
	}
	if templateIndex < 0 {
		response.Fatal(rsp, errors.Errorf("entrypoint template %q not found in spec.templates", entrypoint))
		return rsp, nil
	}

	tpl, ok := templates[templateIndex].(map[string]any)
	if !ok {
		response.Fatal(rsp, errors.New("workflow template entry is not an object"))
		return rsp, nil
	}
	tpl["name"] = entrypoint

	tasks := make([]any, 0, len(steps))
	for _, step := range steps {
		task := map[string]any{
			"name": step.Name,
		}
		if len(step.DependsOn) > 0 {
			task["dependencies"] = toAnySlice(step.DependsOn)
		}
		paramsMap := map[string]any{}
		for key, value := range step.With {
			paramsMap[key] = value
		}
		switch step.Kind {
		case "ToolRun":
			if step.ToolRef != "" {
				paramsMap["toolRef"] = step.ToolRef
			}
		case "MemoryOp", "Checkpoint":
			if step.MemoryRef != "" {
				paramsMap["memoryRef"] = step.MemoryRef
			}
		case "ApprovalGate":
			if step.PolicyRef != "" {
				paramsMap["policyRef"] = step.PolicyRef
			}
		}

		if len(paramsMap) > 0 {
			params := mapToParameters(paramsMap)
			if len(params) > 0 {
				task["arguments"] = map[string]any{
					"parameters": params,
				}
			}
		}

		refName, templateName := resolveTemplateRef(step)
		if refName != "" {
			if templateName == "" {
				templateName = step.Name
			}
			task["templateRef"] = map[string]any{
				"name":     refName,
				"template": templateName,
			}
		} else {
			if templateName == "" {
				templateName = step.Name
			}
			task["template"] = templateName
		}

		tasks = append(tasks, task)
	}

	if err := unstructured.SetNestedSlice(tpl, tasks, "dag", "tasks"); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set dag tasks"))
		return rsp, nil
	}
	templates[templateIndex] = tpl
	if err := unstructured.SetNestedSlice(target.Resource.Object, templates, "spec", "templates"); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot update templates"))
		return rsp, nil
	}

	if err := response.SetDesiredComposedResources(rsp, dcds); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired resources"))
		return rsp, nil
	}

	response.ConditionTrue(rsp, "FunctionSuccess", "Success").
		TargetCompositeAndClaim()

	return rsp, nil
}

func parseSteps(raw any) ([]orchestrationStep, error) {
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("steps must be a list")
	}

	steps := make([]orchestrationStep, 0, len(items))
	for _, item := range items {
		stepMap, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("step is not an object")
		}

		step := orchestrationStep{
			Name:      getString(stepMap["name"]),
			Kind:      getString(stepMap["kind"]),
			DependsOn: getStringSlice(stepMap["dependsOn"]),
			AgentRef:  getString(stepMap["agentRef"]),
			ToolRef:   getString(stepMap["toolRef"]),
			MemoryRef: getString(stepMap["memoryRef"]),
			PolicyRef: getString(stepMap["policyRef"]),
			With:      getStringMap(stepMap["with"]),
		}

		if step.Name == "" {
			return nil, fmt.Errorf("step name is required")
		}

		steps = append(steps, step)
	}

	return steps, nil
}

func resolveTemplateRef(step orchestrationStep) (string, string) {
	switch step.Kind {
	case "AgentRun":
		return step.AgentRef, "agent-run"
	case "ToolRun":
		return step.ToolRef, "run"
	case "MemoryOp":
		return "jangar-memory-op", "run"
	case "ApprovalGate":
		return "jangar-approval-gate", "gate"
	case "SignalWait":
		return "jangar-signal-wait", "wait"
	case "Checkpoint":
		return "jangar-checkpoint", "checkpoint"
	case "SubOrchestration":
		return "jangar-sub-orchestration", "run"
	default:
		return "", step.Name
	}
}

func getString(value any) string {
	s, _ := value.(string)
	return s
}

func getStringSlice(value any) []string {
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

func getStringMap(value any) map[string]any {
	if value == nil {
		return nil
	}
	if out, ok := value.(map[string]any); ok {
		return out
	}
	return nil
}

func mapToParameters(value map[string]any) []any {
	if len(value) == 0 {
		return nil
	}

	params := make([]any, 0, len(value))
	for key, val := range value {
		params = append(params, map[string]any{
			"name":  key,
			"value": fmt.Sprint(val),
		})
	}

	return params
}

func toAnySlice(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}
