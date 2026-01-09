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

func TestRunFunction_MapToList_DefaultKeys(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "map-to-list"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "MapToList",
			"spec": {
				"fromFieldPath": "spec.tags",
				"toResource": "target",
				"toFieldPath": "spec.items"
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "example.org/v1",
					"kind": "XThing",
					"spec": {
						"tags": {
							"beta": 2,
							"alpha": "one"
						}
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"target": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "example.org/v1",
						"kind": "XTarget",
						"spec": {}
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

	target := desiredResource(t, rsp, "target")
	items, _, err := unstructured.NestedSlice(target.Object, "spec", "items")
	if err != nil {
		t.Fatalf("reading spec.items: %v", err)
	}

	want := []any{
		map[string]any{"name": "alpha", "value": "one"},
		map[string]any{"name": "beta", "value": "2"},
	}

	if diff := cmp.Diff(want, items, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("spec.items mismatch (-want +got):\n%s", diff)
	}
}

func TestRunFunction_MapToList_CustomKeys(t *testing.T) {
	req := &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "map-to-list-custom"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "MapToList",
			"spec": {
				"fromFieldPath": "spec.labels",
				"toResource": "target",
				"toFieldPath": "spec.list",
				"listKeys": {
					"nameField": "key",
					"valueField": "val"
				}
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "example.org/v1",
					"kind": "XThing",
					"spec": {
						"labels": {
							"b": "two",
							"a": "one"
						}
					}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"target": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "example.org/v1",
						"kind": "XTarget",
						"spec": {}
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

	target := desiredResource(t, rsp, "target")
	items, _, err := unstructured.NestedSlice(target.Object, "spec", "list")
	if err != nil {
		t.Fatalf("reading spec.list: %v", err)
	}

	want := []any{
		map[string]any{"key": "a", "val": "one"},
		map[string]any{"key": "b", "val": "two"},
	}

	if diff := cmp.Diff(want, items, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("spec.list mismatch (-want +got):\n%s", diff)
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
