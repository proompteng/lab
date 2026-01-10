package main

import (
	"context"
	"sort"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-orchestration-status/input/v1alpha1"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
)

// Function maps Argo workflow node status into orchestration stepStatuses.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

// RunFunction runs the Function.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.OrchestrationStatus{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.WorkflowResource == "" || in.Spec.StepStatusesFieldPath == "" {
		response.Fatal(rsp, errors.New("spec.workflowResource and spec.stepStatusesFieldPath are required"))
		return rsp, nil
	}

	observed := req.GetObserved()
	if observed == nil || observed.GetResources() == nil {
		return f.applyEmptyStatuses(rsp, req, in.Spec.StepStatusesFieldPath)
	}

	workflowRes := observed.GetResources()[in.Spec.WorkflowResource]
	if workflowRes == nil {
		f.log.Info("observed workflow resource missing", "resource", in.Spec.WorkflowResource)
		return f.applyEmptyStatuses(rsp, req, in.Spec.StepStatusesFieldPath)
	}

	workflowObj := &unstructured.Unstructured{}
	if err := resource.AsObject(workflowRes.GetResource(), workflowObj); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot decode observed workflow resource"))
		return rsp, nil
	}

	nodesPath := in.Spec.NodesFieldPath
	if nodesPath == "" {
		nodesPath = "status.nodes"
	}

	nodesRaw, err := fieldpath.Pave(workflowObj.Object).GetValue(nodesPath)
	if err != nil {
		f.log.Info("workflow nodes missing", "path", nodesPath, "error", err)
		return f.applyEmptyStatuses(rsp, req, in.Spec.StepStatusesFieldPath)
	}

	nodesMap, ok := nodesRaw.(map[string]any)
	if !ok {
		response.Fatal(rsp, errors.Errorf("nodes field %q is not a map", nodesPath))
		return rsp, nil
	}

	statuses := collectStepStatuses(nodesMap)
	return f.applyStatuses(rsp, req, in.Spec.StepStatusesFieldPath, statuses)
}

func (f *Function) applyEmptyStatuses(rsp *fnv1.RunFunctionResponse, req *fnv1.RunFunctionRequest, fieldPath string) (*fnv1.RunFunctionResponse, error) {
	return f.applyStatuses(rsp, req, fieldPath, []any{})
}

func (f *Function) applyStatuses(rsp *fnv1.RunFunctionResponse, req *fnv1.RunFunctionRequest, fieldPath string, statuses []any) (*fnv1.RunFunctionResponse, error) {
	xr, err := request.GetDesiredCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composite resource"))
		return rsp, nil
	}

	if err := fieldpath.Pave(xr.Resource.Object).SetValue(fieldPath, statuses); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set step statuses"))
		return rsp, nil
	}

	if err := response.SetDesiredCompositeResource(rsp, xr); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired composite resource"))
		return rsp, nil
	}

	response.ConditionTrue(rsp, "FunctionSuccess", "Success").
		TargetCompositeAndClaim()

	return rsp, nil
}

func collectStepStatuses(nodes map[string]any) []any {
	statusesByName := map[string]map[string]any{}
	for _, raw := range nodes {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := getString(node["displayName"])
		if name == "" {
			name = getString(node["name"])
		}
		if name == "" {
			continue
		}

		nodeType := getString(node["type"])
		if shouldSkipNodeType(nodeType) {
			continue
		}

		status := map[string]any{
			"name":       name,
			"phase":      getString(node["phase"]),
			"startedAt":  getString(node["startedAt"]),
			"finishedAt": getString(node["finishedAt"]),
		}
		statusesByName[name] = status
	}

	keys := make([]string, 0, len(statusesByName))
	for key := range statusesByName {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	statuses := make([]any, 0, len(keys))
	for _, key := range keys {
		statuses = append(statuses, statusesByName[key])
	}

	return statuses
}

func shouldSkipNodeType(nodeType string) bool {
	switch nodeType {
	case "DAG", "Steps", "Workflow":
		return true
	default:
		return false
	}
}

func getString(value any) string {
	s, _ := value.(string)
	return s
}
