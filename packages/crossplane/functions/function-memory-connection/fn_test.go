package main

import (
	"encoding/base64"
	"fmt"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunction_RequiresProvider(t *testing.T) {
	req := baseRequest()
	req.RequiredResources = map[string]*fnv1.Resources{}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	selector := rsp.GetRequirements().GetResources()[providerRequirementKey]
	if selector == nil {
		t.Fatalf("expected provider requirement")
	}
	if selector.GetApiVersion() != "memory.proompteng.ai/v1alpha1" {
		t.Fatalf("unexpected apiVersion: %q", selector.GetApiVersion())
	}
	if selector.GetKind() != "MemoryProvider" {
		t.Fatalf("unexpected kind: %q", selector.GetKind())
	}
	if selector.GetMatchName() != "provider-1" {
		t.Fatalf("unexpected match name: %q", selector.GetMatchName())
	}
	if selector.GetNamespace() != "mem-ns" {
		t.Fatalf("unexpected namespace: %q", selector.GetNamespace())
	}
}

func TestRunFunction_BindsSecretRefWhenSecretMissing(t *testing.T) {
	req := baseRequest()
	req.RequiredResources = map[string]*fnv1.Resources{
		providerRequirementKey: {
			Items: []*fnv1.Resource{
				{
					Resource: resource.MustStructJSON(`{
						"apiVersion": "memory.proompteng.ai/v1alpha1",
						"kind": "MemoryProvider",
						"metadata": {
							"name": "provider-1",
							"namespace": "providers"
						},
						"spec": {
							"postgres": {
								"database": "memdb",
								"connectionSecret": {
									"name": "mem-conn",
									"namespace": "dbns"
								},
								"clusterRef": {
									"namespace": "cluster-ns"
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

	job := desiredResource(t, rsp, "schema-job")
	secretRef := jobEnvSecretRef(t, job.Object, "DATABASE_URL")
	if secretRef["name"] != "mem-conn" {
		t.Fatalf("secret name mismatch: %v", secretRef["name"])
	}
	if secretRef["key"] != "uri" {
		t.Fatalf("secret key mismatch: %v", secretRef["key"])
	}
}

func TestRunFunction_BindsConnection(t *testing.T) {
	req := baseRequest()
	dsn := "postgresql://user:pass@db.example.com:5432/memdb"
	encoded := base64.StdEncoding.EncodeToString([]byte(dsn))

	req.RequiredResources = map[string]*fnv1.Resources{
		providerRequirementKey: {
			Items: []*fnv1.Resource{
				{
					Resource: resource.MustStructJSON(`{
						"apiVersion": "memory.proompteng.ai/v1alpha1",
						"kind": "MemoryProvider",
						"metadata": {
							"name": "provider-1",
							"namespace": "providers"
						},
						"spec": {
							"postgres": {
								"connectionSecret": {
									"name": "mem-conn",
									"namespace": "dbns"
								},
								"clusterRef": {
									"namespace": "cluster-ns"
								}
							}
						}
					}`),
				},
			},
		},
		secretRequirementKey: {
			Items: []*fnv1.Resource{
				{
					Resource: resource.MustStructJSON(fmt.Sprintf(`{
						"apiVersion": "v1",
						"kind": "Secret",
						"metadata": {
							"name": "mem-conn",
							"namespace": "dbns"
						},
						"data": {
							"uri": "%s"
						}
					}`, encoded)),
				},
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	xr := desiredComposite(t, rsp)
	secretRef := nestedMap(t, xr.Object, "status", "connectionSecretRef")
	if diff := cmp.Diff(map[string]any{"name": "mem-conn", "namespace": "dbns"}, secretRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("connection secret ref mismatch (-want +got):\n%s", diff)
	}

	status := nestedMap(t, xr.Object, "status", "connection")
	if status["endpoint"] != "db.example.com:5432" {
		t.Fatalf("unexpected endpoint: %v", status["endpoint"])
	}
	if status["database"] != "memdb" {
		t.Fatalf("unexpected database: %v", status["database"])
	}
	if status["schema"] != "mem" {
		t.Fatalf("unexpected schema: %v", status["schema"])
	}

	job := desiredResource(t, rsp, "schema-job")
	if ns := job.GetNamespace(); ns != "dbns" {
		t.Fatalf("job namespace mismatch: %q", ns)
	}
	env := jobEnv(t, job.Object)
	if env["DATABASE_URL"] != dsn {
		t.Fatalf("DATABASE_URL mismatch: %q", env["DATABASE_URL"])
	}
	if env["DB_SCHEMA"] != "mem" {
		t.Fatalf("DB_SCHEMA mismatch: %q", env["DB_SCHEMA"])
	}

	cfg := desiredResource(t, rsp, "sql-config")
	if ns := cfg.GetNamespace(); ns != "dbns" {
		t.Fatalf("configmap namespace mismatch: %q", ns)
	}
}

func TestRunFunction_ObservedFallback(t *testing.T) {
	req := baseRequest()
	req.Desired.Composite.Resource = resource.MustStructJSON(`{
		"apiVersion": "memory.proompteng.ai/v1alpha1",
		"kind": "Memory",
		"metadata": {
			"name": "mem",
			"namespace": "mem-ns"
		},
		"spec": {
			"dataset": {}
		},
		"status": {}
	}`)
	req.Observed = &fnv1.State{
		Composite: &fnv1.Resource{
			Resource: resource.MustStructJSON(`{
				"apiVersion": "memory.proompteng.ai/v1alpha1",
				"kind": "Memory",
				"metadata": {
					"name": "mem",
					"namespace": "mem-ns"
				},
				"spec": {
					"providerRef": {
						"name": "provider-1"
					},
					"dataset": {
						"schema": "mem"
					}
				}
			}`),
		},
	}
	dsn := "postgresql://user:pass@db.example.com:5432/memdb"
	encoded := base64.StdEncoding.EncodeToString([]byte(dsn))

	req.RequiredResources = map[string]*fnv1.Resources{
		providerRequirementKey: {
			Items: []*fnv1.Resource{
				{
					Resource: resource.MustStructJSON(`{
						"apiVersion": "memory.proompteng.ai/v1alpha1",
						"kind": "MemoryProvider",
						"metadata": {
							"name": "provider-1",
							"namespace": "providers"
						},
						"spec": {
							"postgres": {
								"connectionSecret": {
									"name": "mem-conn",
									"namespace": "dbns"
								},
								"clusterRef": {
									"namespace": "cluster-ns"
								}
							}
						}
					}`),
				},
			},
		},
		secretRequirementKey: {
			Items: []*fnv1.Resource{
				{
					Resource: resource.MustStructJSON(fmt.Sprintf(`{
						"apiVersion": "v1",
						"kind": "Secret",
						"metadata": {
							"name": "mem-conn",
							"namespace": "dbns"
						},
						"data": {
							"uri": "%s"
						}
					}`, encoded)),
				},
			},
		},
	}

	f := &Function{log: logging.NewNopLogger()}
	rsp, err := f.RunFunction(t.Context(), req)
	if err != nil {
		t.Fatalf("RunFunction returned error: %v", err)
	}

	xr := desiredComposite(t, rsp)
	secretRef := nestedMap(t, xr.Object, "status", "connectionSecretRef")
	if diff := cmp.Diff(map[string]any{"name": "mem-conn", "namespace": "dbns"}, secretRef, cmpopts.EquateEmpty()); diff != "" {
		t.Fatalf("connection secret ref mismatch (-want +got):\n%s", diff)
	}

	job := desiredResource(t, rsp, "schema-job")
	env := jobEnv(t, job.Object)
	if env["DATABASE_URL"] != dsn {
		t.Fatalf("DATABASE_URL mismatch: %q", env["DATABASE_URL"])
	}
	if env["DB_SCHEMA"] != "mem" {
		t.Fatalf("DB_SCHEMA mismatch: %q", env["DB_SCHEMA"])
	}
}

func baseRequest() *fnv1.RunFunctionRequest {
	return &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "memory-connection"},
		Input: resource.MustStructJSON(`{
			"apiVersion": "fn.proompteng.ai/v1alpha1",
			"kind": "MemoryConnectionBinding",
			"spec": {
				"providerRefFieldPath": "spec.providerRef.name",
				"resources": {
					"job": "schema-job",
					"configMap": "sql-config"
				},
				"targetNamespaceFieldPaths": {
					"job": "metadata.namespace",
					"configMap": "metadata.namespace"
				},
				"dsnEnvVar": "DATABASE_URL",
				"schemaEnvVar": "DB_SCHEMA",
				"connectionSecretRefFieldPath": "status.connectionSecretRef",
				"statusFieldPaths": {
					"endpoint": "status.connection.endpoint",
					"database": "status.connection.database",
					"schema": "status.connection.schema"
				}
			}
		}`),
		Desired: &fnv1.State{
			Composite: &fnv1.Resource{
				Resource: resource.MustStructJSON(`{
					"apiVersion": "memory.proompteng.ai/v1alpha1",
					"kind": "Memory",
					"metadata": {
						"name": "mem",
						"namespace": "mem-ns"
					},
					"spec": {
						"providerRef": {
							"name": "provider-1"
						},
						"dataset": {
							"schema": "mem"
						}
					},
					"status": {}
				}`),
			},
			Resources: map[string]*fnv1.Resource{
				"schema-job": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "batch/v1",
						"kind": "Job",
						"metadata": {
							"name": "schema-job"
						},
						"spec": {
							"template": {
								"spec": {
									"containers": [
										{
											"name": "worker",
											"env": [
												{
													"name": "EXISTING",
													"value": "keep"
												}
											]
										}
									],
									"restartPolicy": "Never"
								}
							}
						}
					}`),
				},
				"sql-config": {
					Resource: resource.MustStructJSON(`{
						"apiVersion": "v1",
						"kind": "ConfigMap",
						"metadata": {
							"name": "sql-config"
						},
						"data": {}
					}`),
				},
			},
		},
	}
}

func desiredResource(t *testing.T, rsp *fnv1.RunFunctionResponse, name string) *unstructured.Unstructured {
	t.Helper()

	res := rsp.GetDesired().GetResources()[name]
	if res == nil {
		t.Fatalf("desired resource %q not found", name)
	}

	out := &unstructured.Unstructured{}
	if err := resource.AsObject(res.GetResource(), out); err != nil {
		t.Fatalf("decoding desired resource %q: %v", name, err)
	}

	return out
}

func desiredComposite(t *testing.T, rsp *fnv1.RunFunctionResponse) *unstructured.Unstructured {
	t.Helper()

	res := rsp.GetDesired().GetComposite()
	if res == nil {
		t.Fatalf("desired composite not found")
	}

	out := &unstructured.Unstructured{}
	if err := resource.AsObject(res.GetResource(), out); err != nil {
		t.Fatalf("decoding desired composite: %v", err)
	}

	return out
}

func nestedMap(t *testing.T, obj map[string]any, fields ...string) map[string]any {
	t.Helper()

	value, found, err := unstructured.NestedMap(obj, fields...)
	if err != nil || !found {
		t.Fatalf("missing field %v", fields)
	}
	return value
}

func jobEnv(t *testing.T, obj map[string]any) map[string]string {
	t.Helper()

	containers, found, err := unstructured.NestedSlice(obj, "spec", "template", "spec", "containers")
	if err != nil || !found || len(containers) == 0 {
		t.Fatalf("containers not found")
	}
	container, ok := containers[0].(map[string]any)
	if !ok {
		t.Fatalf("container invalid")
	}
	envRaw, _, _ := unstructured.NestedSlice(container, "env")
	env := map[string]string{}
	for _, entry := range envRaw {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, _ := item["name"].(string)
		value, _ := item["value"].(string)
		if name != "" {
			env[name] = value
		}
	}
	return env
}

func jobEnvSecretRef(t *testing.T, obj map[string]any, name string) map[string]any {
	t.Helper()

	containers, found, err := unstructured.NestedSlice(obj, "spec", "template", "spec", "containers")
	if err != nil || !found || len(containers) == 0 {
		t.Fatalf("containers not found")
	}
	container, ok := containers[0].(map[string]any)
	if !ok {
		t.Fatalf("container invalid")
	}
	envRaw, _, _ := unstructured.NestedSlice(container, "env")
	for _, entry := range envRaw {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if item["name"] != name {
			continue
		}
		valueFrom, _ := item["valueFrom"].(map[string]any)
		secretKeyRef, _ := valueFrom["secretKeyRef"].(map[string]any)
		return secretKeyRef
	}
	t.Fatalf("env var %q not found", name)
	return nil
}
