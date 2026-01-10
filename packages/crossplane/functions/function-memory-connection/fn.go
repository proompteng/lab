package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

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
//
//nolint:gocognit // Connection binding requires multiple guard clauses and branches.
func (f *Function) RunFunction(ctx context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
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

	observedXR, _ := request.GetObservedCompositeResource(req)
	getCompositeString := func(path string) string {
		if path == "" {
			return ""
		}
		if xr != nil {
			if value := getStringField(xr.Resource.Object, path); value != "" {
				return value
			}
		}
		if observedXR != nil {
			return getStringField(observedXR.Resource.Object, path)
		}
		return ""
	}
	claimNamespace := getCompositeString("spec.claimRef.namespace")
	if claimNamespace == "" && xr != nil {
		if labels := xr.Resource.GetLabels(); labels != nil {
			claimNamespace = labels["crossplane.io/claim-namespace"]
		}
	}

	dcds, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return rsp, nil
	}

	providerName := getCompositeString(in.Spec.ProviderRefFieldPath)
	if providerName == "" {
		desiredHasSpec := xr != nil && xr.Resource != nil && xr.Resource.Object["spec"] != nil
		observedHasSpec := observedXR != nil && observedXR.Resource != nil && observedXR.Resource.Object["spec"] != nil
		f.log.Info("providerRef name missing", "providerRefFieldPath", in.Spec.ProviderRefFieldPath, "desiredHasSpec", desiredHasSpec, "observedHasSpec", observedHasSpec)
		response.Fatal(rsp, errors.New("providerRef name is required"))
		return rsp, nil
	}

	client := dynamic.Interface(nil)
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		config, err := rest.InClusterConfig()
		if err != nil {
			f.log.Info("failed to load in-cluster config", "error", err)
		} else if dyn, err := dynamic.NewForConfig(config); err != nil {
			f.log.Info("failed to create dynamic client", "error", err)
		} else {
			client = dyn
		}
	}

	required, _ := request.GetRequiredResources(req)
	providerResource := findRequired(required, providerRequirementKey)
	if providerResource == nil || providerResource.GetName() != providerName {
		requireNamespace := firstNonEmpty(claimNamespace, xr.Resource.GetNamespace())
		if client != nil {
			providerGvr := schema.GroupVersionResource{Group: "memory.proompteng.ai", Version: "v1alpha1", Resource: "memoryproviders"}
			if fetched, err := fetchResource(ctx, client, providerGvr, requireNamespace, providerName); err != nil {
				f.log.Info("failed to fetch provider", "providerName", providerName, "providerNamespace", requireNamespace, "error", err)
			} else if fetched != nil {
				providerResource = fetched
			}
		}
		if providerResource == nil || providerResource.GetName() != providerName {
			f.log.Info("provider requirement missing", "providerName", providerName, "providerNamespace", requireNamespace, "requiredKeys", requiredKeys(required))
			setRequirement(rsp, providerRequirementKey, "memory.proompteng.ai/v1alpha1", "MemoryProvider", providerName, requireNamespace)
			return rsp, nil
		}
	}

	providerNamespace := providerResource.GetNamespace()
	if providerNamespace == "" {
		providerNamespace = firstNonEmpty(claimNamespace, xr.Resource.GetNamespace())
	}

	connSecretName := getStringField(providerResource.Object, "spec.postgres.connectionSecret.name")
	connSecretNamespace := getStringField(providerResource.Object, "spec.postgres.connectionSecret.namespace")
	clusterNamespace := getStringField(providerResource.Object, "spec.postgres.clusterRef.namespace")

	if connSecretNamespace == "" {
		connSecretNamespace = providerNamespace
	}

	targetNamespace := firstNonEmpty(connSecretNamespace, clusterNamespace, providerNamespace, claimNamespace, xr.Resource.GetNamespace())
	applyTargetNamespaces(dcds, in.Spec, targetNamespace)

	if connSecretName == "" {
		response.Warning(rsp, errors.New("memory provider missing connectionSecret"))
		_ = response.SetDesiredComposedResources(rsp, dcds)
		return rsp, nil
	}

	secretResource := findRequired(required, secretRequirementKey)
	if secretResource == nil && client != nil && connSecretNamespace != "" {
		secretGvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
		if fetched, err := fetchResource(ctx, client, secretGvr, connSecretNamespace, connSecretName); err != nil {
			f.log.Info("failed to fetch secret", "secretName", connSecretName, "secretNamespace", connSecretNamespace, "error", err)
		} else if fetched != nil {
			secretResource = fetched
		}
	}
	dsn := ""
	if secretResource != nil {
		data, _, _ := unstructured.NestedStringMap(secretResource.Object, "data")
		dsn = decodeSecretValue(data, "uri")
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
	}

	endpoint, database := parseEndpointAndDatabase(dsn)
	if database == "" {
		database = getStringField(providerResource.Object, "spec.postgres.database")
	}
	schema := getCompositeString("spec.dataset.schema")
	providerSchema := getStringField(providerResource.Object, "spec.postgres.schema")
	if schema == "" && providerSchema != "" {
		schema = providerSchema
	}
	if schema != "" && providerSchema != "" && schema != providerSchema {
		response.Fatal(rsp, errors.Errorf("memory schema %q does not match provider schema %q", schema, providerSchema))
		return rsp, nil
	}

	if in.Spec.Resources.Job != "" {
		job := dcds[resource.Name(in.Spec.Resources.Job)]
		if job != nil {
			if in.Spec.DsnEnvVar != "" {
				if dsn != "" {
					_ = setJobEnv(job.Resource.Object, in.Spec.DsnEnvVar, dsn)
				} else {
					_ = setJobEnvFromSecret(job.Resource.Object, in.Spec.DsnEnvVar, connSecretName, "uri")
				}
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
	reqs := rsp.GetRequirements()
	if reqs == nil {
		reqs = &fnv1.Requirements{
			Resources: map[string]*fnv1.ResourceSelector{},
		}
		rsp.Requirements = reqs
	}
	if reqs.GetResources() == nil {
		reqs.Resources = map[string]*fnv1.ResourceSelector{}
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
	reqs.Resources[key] = selector
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

func setJobEnvFromSecret(obj map[string]any, name, secretName, key string) error {
	containers, found, err := unstructured.NestedSlice(obj, "spec", "template", "spec", "containers")
	if err != nil || !found || len(containers) == 0 {
		return fmt.Errorf("job containers not found")
	}

	container, ok := containers[0].(map[string]any)
	if !ok {
		return fmt.Errorf("job container is not an object")
	}

	env, _, _ := unstructured.NestedSlice(container, "env")
	valueFrom := map[string]any{
		"secretKeyRef": map[string]any{
			"name": secretName,
			"key":  key,
		},
	}
	updated := false
	for i, entry := range env {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if item["name"] == name {
			delete(item, "value")
			item["valueFrom"] = valueFrom
			env[i] = item
			updated = true
			break
		}
	}

	if !updated {
		env = append(env, map[string]any{"name": name, "valueFrom": valueFrom})
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
	if err == nil {
		if s, ok := value.(string); ok {
			return s
		}
	}
	segments := strings.Split(path, ".")
	if len(segments) == 0 {
		return ""
	}
	if s, found, err := unstructured.NestedString(obj, segments...); err == nil && found {
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

func requiredKeys(required map[string][]resource.Required) []string {
	keys := make([]string, 0, len(required))
	for key := range required {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func fetchResource(ctx context.Context, client dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string) (*unstructured.Unstructured, error) {
	if client == nil {
		return nil, nil
	}
	var resourceClient dynamic.ResourceInterface
	if namespace != "" {
		resourceClient = client.Resource(gvr).Namespace(namespace)
	} else {
		resourceClient = client.Resource(gvr)
	}
	return resourceClient.Get(ctx, name, metav1.GetOptions{})
}
