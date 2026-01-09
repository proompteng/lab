package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-memory-connection/input/v1alpha1"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
)

const (
	providerRequirementKey = "provider"
	secretRequirementKey   = "connectionSecret"
)

// Function binds Memory provider connection details into composed resources.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

// RunFunction runs the Function.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.MemoryConnectionBinding{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.ProviderRefFieldPath == "" {
		response.Fatal(rsp, errors.New("spec.providerRefFieldPath is required"))
		return rsp, nil
	}

	xr, err := request.GetDesiredCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composite resource"))
		return rsp, nil
	}

	dcds, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return rsp, nil
	}

	providerName := getStringField(xr.Resource.Object, in.Spec.ProviderRefFieldPath)
	if providerName == "" {
		response.Fatal(rsp, errors.New("providerRef name is required"))
		return rsp, nil
	}

	required, _ := request.GetRequiredResources(req)
	providerResource := findRequired(required, providerRequirementKey)
	if providerResource == nil || providerResource.GetName() != providerName {
		setRequirement(rsp, providerRequirementKey, "memory.proompteng.ai/v1alpha1", "MemoryProvider", providerName, xr.Resource.GetNamespace())
		return rsp, nil
	}

	providerNamespace := providerResource.GetNamespace()
	if providerNamespace == "" {
		providerNamespace = xr.Resource.GetNamespace()
	}

	connSecretName := getStringField(providerResource.Object, "spec.postgres.connectionSecret.name")
	connSecretNamespace := getStringField(providerResource.Object, "spec.postgres.connectionSecret.namespace")
	clusterNamespace := getStringField(providerResource.Object, "spec.postgres.clusterRef.namespace")

	if connSecretNamespace == "" {
		connSecretNamespace = providerNamespace
	}

	targetNamespace := firstNonEmpty(connSecretNamespace, clusterNamespace, providerNamespace, xr.Resource.GetNamespace())
	applyTargetNamespaces(dcds, in.Spec, targetNamespace)

	if connSecretName == "" {
		response.Warning(rsp, errors.New("memory provider missing connectionSecret"))
		_ = response.SetDesiredComposedResources(rsp, dcds)
		return rsp, nil
	}

	secretResource := findRequired(required, secretRequirementKey)
	if secretResource == nil || secretResource.GetName() != connSecretName || secretResource.GetNamespace() != connSecretNamespace {
		setRequirement(rsp, secretRequirementKey, "v1", "Secret", connSecretName, connSecretNamespace)
		_ = response.SetDesiredComposedResources(rsp, dcds)
		return rsp, nil
	}

	data, _, _ := unstructured.NestedStringMap(secretResource.Object, "data")
	dsn := decodeSecretValue(data, "uri")
	if dsn == "" {
		host := decodeSecretValue(data, "host")
		port := decodeSecretValue(data, "port")
		user := decodeSecretValue(data, "user")
		password := decodeSecretValue(data, "password")
		database := decodeSecretValue(data, "dbname")
		if host != "" && user != "" && database != "" {
			if port != "" {
				host = fmt.Sprintf("%s:%s", host, port)
			}
			dsn = fmt.Sprintf("postgresql://%s:%s@%s/%s", url.PathEscape(user), url.PathEscape(password), host, database)
		}
	}

	endpoint, database := parseEndpointAndDatabase(dsn)
	schema := getStringField(xr.Resource.Object, "spec.dataset.schema")

	if in.Spec.Resources.Job != "" {
		job := dcds[resource.Name(in.Spec.Resources.Job)]
		if job != nil {
			if dsn != "" && in.Spec.DsnEnvVar != "" {
				_ = setJobEnv(job.Resource.Object, in.Spec.DsnEnvVar, dsn)
			}
			if schema != "" && in.Spec.SchemaEnvVar != "" {
				_ = setJobEnv(job.Resource.Object, in.Spec.SchemaEnvVar, schema)
			}
		}
	}

	if in.Spec.ConnectionSecretRefFieldPath != "" {
		_ = fieldpath.Pave(xr.Resource.Object).SetValue(in.Spec.ConnectionSecretRefFieldPath, map[string]any{
			"name":      connSecretName,
			"namespace": connSecretNamespace,
		})
	}

	if endpoint != "" && in.Spec.StatusFieldPaths.Endpoint != "" {
		_ = fieldpath.Pave(xr.Resource.Object).SetValue(in.Spec.StatusFieldPaths.Endpoint, endpoint)
	}
	if database != "" && in.Spec.StatusFieldPaths.Database != "" {
		_ = fieldpath.Pave(xr.Resource.Object).SetValue(in.Spec.StatusFieldPaths.Database, database)
	}
	if schema != "" && in.Spec.StatusFieldPaths.Schema != "" {
		_ = fieldpath.Pave(xr.Resource.Object).SetValue(in.Spec.StatusFieldPaths.Schema, schema)
	}

	if err := response.SetDesiredCompositeResource(rsp, xr); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired composite"))
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

func setRequirement(rsp *fnv1.RunFunctionResponse, key, apiVersion, kind, name, namespace string) {
	if rsp.Requirements == nil {
		rsp.Requirements = &fnv1.Requirements{Resources: map[string]*fnv1.ResourceSelector{}}
	}
	selector := &fnv1.ResourceSelector{
		ApiVersion: apiVersion,
		Kind:       kind,
		Match:      &fnv1.ResourceSelector_MatchName{MatchName: name},
	}
	if namespace != "" {
		ns := namespace
		selector.Namespace = &ns
	}
	rsp.Requirements.Resources[key] = selector
}

func findRequired(required map[string][]resource.Required, key string) *unstructured.Unstructured {
	items := required[key]
	if len(items) == 0 {
		return nil
	}
	return items[0].Resource
}

func applyTargetNamespaces(dcds map[resource.Name]*resource.DesiredComposed, spec v1alpha1.MemoryConnectionBindingSpec, namespace string) {
	if namespace == "" {
		return
	}

	if spec.Resources.Job != "" && spec.TargetNamespaceFieldPaths.Job != "" {
		if job := dcds[resource.Name(spec.Resources.Job)]; job != nil {
			_ = fieldpath.Pave(job.Resource.Object).SetValue(spec.TargetNamespaceFieldPaths.Job, namespace)
		}
	}
	if spec.Resources.ConfigMap != "" && spec.TargetNamespaceFieldPaths.ConfigMap != "" {
		if cfg := dcds[resource.Name(spec.Resources.ConfigMap)]; cfg != nil {
			_ = fieldpath.Pave(cfg.Resource.Object).SetValue(spec.TargetNamespaceFieldPaths.ConfigMap, namespace)
		}
	}
}

func setJobEnv(obj map[string]any, name, value string) error {
	containers, found, err := unstructured.NestedSlice(obj, "spec", "template", "spec", "containers")
	if err != nil || !found || len(containers) == 0 {
		return fmt.Errorf("job containers not found")
	}

	container, ok := containers[0].(map[string]any)
	if !ok {
		return fmt.Errorf("job container is invalid")
	}

	env, _, _ := unstructured.NestedSlice(container, "env")
	updated := false
	for i, entry := range env {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if item["name"] == name {
			item["value"] = value
			env[i] = item
			updated = true
			break
		}
	}

	if !updated {
		env = append(env, map[string]any{"name": name, "value": value})
	}

	if err := unstructured.SetNestedSlice(container, env, "env"); err != nil {
		return err
	}
	containers[0] = container
	return unstructured.SetNestedSlice(obj, containers, "spec", "template", "spec", "containers")
}

func decodeSecretValue(data map[string]string, key string) string {
	raw, ok := data[key]
	if !ok || raw == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return ""
	}
	return string(decoded)
}

func parseEndpointAndDatabase(dsn string) (string, string) {
	if dsn == "" {
		return "", ""
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		return "", ""
	}
	endpoint := parsed.Host
	database := strings.TrimPrefix(parsed.Path, "/")
	return endpoint, database
}

func getStringField(obj map[string]any, path string) string {
	if path == "" {
		return ""
	}
	value, err := fieldpath.Pave(obj).GetValue(path)
	if err != nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
