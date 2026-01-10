package main

import (
	"encoding/json"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

type providerSpecPayload struct {
	Name            string            `json:"name"`
	Binary          string            `json:"binary"`
	ArgsTemplate    []string          `json:"argsTemplate"`
	EnvTemplate     map[string]string `json:"envTemplate"`
	InputFiles      []map[string]any  `json:"inputFiles"`
	OutputArtifacts []map[string]any  `json:"outputArtifacts"`
}

func TestRunFunction_WritesProviderJson(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "provider-json"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "AgentProviderJson",
			"spec": {
				"targetConfigMap": "provider-config"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "agents.proompteng.ai/v1alpha1",
					"kind": "AgentProvider",
					"metadata": {"name": "codex"},
					"spec": {
						"binary": "/usr/local/bin/codex",
						"argsTemplate": ["exec", "--repo", "{{inputs.repository}}"],
						"envTemplate": {
							"WORKFLOW_STAGE": "{{inputs.stage}}"
						},
						"inputFiles": [
							{"path": "/workspace/prompt.json", "content": "{{payloads.promptJson}}"}
						],
						"outputArtifacts": [
							{"name": "run-log", "path": "/workspace/log.txt"}
						]
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"provider-config": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "v1",
						"kind": "ConfigMap",
						"metadata": {"name": "codex-agent-provider"},
						"data": {}
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

	cfg := desiredResource(t, rsp, "provider-config")
	data, _, err := unstructured.NestedStringMap(cfg.Object, "data")
	if err != nil {
		t.Fatalf("reading configmap data: %v", err)
	}
	raw := data["codex.json"]
	if raw == "" {
		t.Fatalf("expected provider JSON to be written")
	}

	var decoded providerSpecPayload
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("failed to decode provider JSON: %v", err)
	}

	if diff := cmp.Diff("codex", decoded.Name); diff != "" {
		t.Fatalf("provider name mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff("/usr/local/bin/codex", decoded.Binary); diff != "" {
		t.Fatalf("binary mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"exec", "--repo", "{{inputs.repository}}"}, decoded.ArgsTemplate); diff != "" {
		t.Fatalf("args template mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff(map[string]string{"WORKFLOW_STAGE": "{{inputs.stage}}"}, decoded.EnvTemplate, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("env template mismatch (-want +got):\n%s", diff)
	}
	if len(decoded.InputFiles) != 1 {
		t.Fatalf("expected inputFiles to be preserved")
	}
	if len(decoded.OutputArtifacts) != 1 {
		t.Fatalf("expected outputArtifacts to be preserved")
	}
}

func TestRunFunction_MissingConfigMap(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "missing-config"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "AgentProviderJson",
			"spec": {
				"targetConfigMap": "missing"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "agents.proompteng.ai/v1alpha1",
					"kind": "AgentProvider",
					"metadata": {"name": "codex"},
					"spec": {
						"binary": "/usr/local/bin/codex"
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	if len(rsp.GetResults()) == 0 || rsp.GetResults()[0].GetSeverity() != fnv1.Severity_SEVERITY_FATAL {
		t.Fatalf("expected fatal result when configmap missing")
	}
}

func desiredResource(t *testing.T, rsp *fnv1.RunFunctionResponse, resourceName string) *unstructured.Unstructured {
	t.Helper()

	res := rsp.GetDesired().GetResources()[resourceName]
	if res == nil {
		t.Fatalf("desired resource %q not found", resourceName)
	}

	obj := &unstructured.Unstructured{}
	if err := resource.AsObject(res.GetResource(), obj); err != nil {
		t.Fatalf("decoding desired resource %q: %v", resourceName, err)
	}

	return obj
}
