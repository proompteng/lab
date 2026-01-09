package main

import (
	"context"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunction_RendersSql(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "memory-sql"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "MemorySqlRender",
			"spec": {
				"targetConfigMap": "sql-config",
				"sqlKey": "schema.sql",
				"embeddingsDimensionFieldPath": "spec.dataset.embeddingDimension"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "memory.proompteng.ai/v1alpha1",
					"kind": "Memory",
					"spec": {
						"dataset": {
							"embeddingDimension": 768
						}
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"sql-config": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "v1",
						"kind": "ConfigMap",
						"metadata": {
							"name": "sql-config"
						},
						"data": {
							"schema.sql": "CREATE TABLE embeddings (vec vector({{EMBEDDINGS_DIMENSION}}));"
						}
					}`),
				},
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(context.Background(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	cfg := desiredResource(t, rsp, "sql-config")
	data, _, err := unstructured.NestedStringMap(cfg.Object, "data")
	if err != nil {
		t.Fatalf("reading configmap data: %v", err)
	}

	want := map[string]string{
		"schema.sql": "CREATE TABLE embeddings (vec vector(768));",
	}
	if diff := cmp.Diff(want, data, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("rendered sql mismatch (-want +got):\n%s", diff)
	}
}

func TestRunFunction_DefaultsDimension(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "memory-sql-default"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "MemorySqlRender",
			"spec": {
				"targetConfigMap": "sql-config",
				"sqlKey": "schema.sql",
				"embeddingsDimensionFieldPath": "spec.dataset.embeddingDimension"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "memory.proompteng.ai/v1alpha1",
					"kind": "Memory",
					"spec": {}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"sql-config": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "v1",
						"kind": "ConfigMap",
						"metadata": {
							"name": "sql-config"
						},
						"data": {
							"schema.sql": "SELECT {{EMBEDDINGS_DIMENSION}};"
						}
					}`),
				},
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(context.Background(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	cfg := desiredResource(t, rsp, "sql-config")
	data, _, err := unstructured.NestedStringMap(cfg.Object, "data")
	if err != nil {
		t.Fatalf("reading configmap data: %v", err)
	}

	want := map[string]string{
		"schema.sql": "SELECT 1536;",
	}
	if diff := cmp.Diff(want, data, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("default sql mismatch (-want +got):\n%s", diff)
	}
}

func desiredResource(t *testing.T, rsp *fnv1.RunFunctionResponse, name string) *unstructured.Unstructured {
	t.Helper()

	res := rsp.GetDesired().GetResources()[name]
	if res == nil {
		t.Fatalf("desired resource %q not found", name)
	}

	out := &unstructured.Unstructured{}
	if err := resource.AsObject(res.Resource, out); err != nil {
		t.Fatalf("decoding desired resource %q: %v", name, err)
	}

	return out
}
