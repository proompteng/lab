package main

import (
	"context"
	"encoding/json"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-agent-provider-json/input/v1alpha1"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
)

// Function renders agent provider JSON config maps.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

type providerSpec struct {
	Name            string            `json:"name,omitempty"`
	Binary          string            `json:"binary"`
	ArgsTemplate    []string          `json:"argsTemplate,omitempty"`
	EnvTemplate     map[string]string `json:"envTemplate,omitempty"`
	InputFiles      []inputFile       `json:"inputFiles,omitempty"`
	OutputArtifacts []outputArtifact  `json:"outputArtifacts,omitempty"`
}

type inputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type outputArtifact struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// RunFunction runs the Function.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.AgentProviderJson{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.TargetConfigMap == "" {
		response.Fatal(rsp, errors.New("spec.targetConfigMap is required"))
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

	claimName := getClaimName(xr, observedXR)
	providerName := claimName
	if providerName == "" {
		providerName = getCompositeName(xr, observedXR)
	}
	binary := getStringFieldWithFallback(xr, observedXR, "spec.binary")
	if binary == "" {
		response.Fatal(rsp, errors.New("spec.binary is required"))
		return rsp, nil
	}

	spec := providerSpec{
		Name:            providerName,
		Binary:          binary,
		ArgsTemplate:    getStringSliceFieldWithFallback(xr, observedXR, "spec.argsTemplate"),
		EnvTemplate:     getStringMapFieldWithFallback(xr, observedXR, "spec.envTemplate"),
		InputFiles:      getInputFilesFieldWithFallback(xr, observedXR, "spec.inputFiles"),
		OutputArtifacts: getOutputArtifactsFieldWithFallback(xr, observedXR, "spec.outputArtifacts"),
	}

	rendered, err := json.Marshal(spec)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot marshal provider spec"))
		return rsp, nil
	}

	target, ok := dcds[resource.Name(in.Spec.TargetConfigMap)]
	if !ok {
		response.Fatal(rsp, errors.Errorf("desired resource %q not found", in.Spec.TargetConfigMap))
		return rsp, nil
	}

	data, _, err := unstructured.NestedStringMap(target.Resource.Object, "data")
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read configmap data"))
		return rsp, nil
	}
	if data == nil {
		data = map[string]string{}
	}

	key := in.Spec.JsonKey
	if key == "" {
		if providerName != "" {
			key = providerName + ".json"
		} else {
			key = "provider.json"
		}
	}

	data[key] = string(rendered)

	if err := unstructured.SetNestedStringMap(target.Resource.Object, data, "data"); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot update configmap data"))
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

func getStringField(obj map[string]any, path string) string {
	if obj == nil {
		return ""
	}
	value, err := fieldpath.Pave(obj).GetValue(path)
	if err != nil {
		return ""
	}
	if str, ok := value.(string); ok {
		return str
	}
	return ""
}

func getCompositeName(xr, observedXR *resource.Composite) string {
	if xr != nil && xr.Resource != nil {
		if name := xr.Resource.GetName(); name != "" {
			return name
		}
	}
	if observedXR != nil && observedXR.Resource != nil {
		return observedXR.Resource.GetName()
	}
	return ""
}

func getClaimName(xr, observedXR *resource.Composite) string {
	if xr != nil && xr.Resource != nil {
		if labels := xr.Resource.GetLabels(); labels != nil {
			if name := labels["crossplane.io/claim-name"]; name != "" {
				return name
			}
		}
	}
	if observedXR != nil && observedXR.Resource != nil {
		if labels := observedXR.Resource.GetLabels(); labels != nil {
			if name := labels["crossplane.io/claim-name"]; name != "" {
				return name
			}
		}
	}
	return ""
}

func getStringFieldWithFallback(xr, observedXR *resource.Composite, path string) string {
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

func getStringSliceField(obj map[string]any, path string) []string {
	if obj == nil {
		return nil
	}
	value, err := fieldpath.Pave(obj).GetValue(path)
	if err != nil {
		return nil
	}
	rawSlice, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(rawSlice))
	for _, entry := range rawSlice {
		if str, ok := entry.(string); ok {
			out = append(out, str)
		}
	}
	return out
}

func getStringSliceFieldWithFallback(xr, observedXR *resource.Composite, path string) []string {
	if xr != nil {
		if value := getStringSliceField(xr.Resource.Object, path); len(value) > 0 {
			return value
		}
	}
	if observedXR != nil {
		return getStringSliceField(observedXR.Resource.Object, path)
	}
	return nil
}

func getStringMapField(obj map[string]any, path string) map[string]string {
	if obj == nil {
		return nil
	}
	value, err := fieldpath.Pave(obj).GetValue(path)
	if err != nil {
		return nil
	}
	rawMap, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(rawMap))
	for key, raw := range rawMap {
		switch typed := raw.(type) {
		case string:
			out[key] = typed
		default:
			out[key] = ""
		}
	}
	return out
}

func getStringMapFieldWithFallback(xr, observedXR *resource.Composite, path string) map[string]string {
	if xr != nil {
		if value := getStringMapField(xr.Resource.Object, path); len(value) > 0 {
			return value
		}
	}
	if observedXR != nil {
		return getStringMapField(observedXR.Resource.Object, path)
	}
	return nil
}

func getInputFilesField(obj map[string]any, path string) []inputFile {
	rawItems := getListField(obj, path)
	if rawItems == nil {
		return nil
	}
	out := make([]inputFile, 0, len(rawItems))
	for _, raw := range rawItems {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, inputFile{
			Path:    getStringValue(entry["path"]),
			Content: getStringValue(entry["content"]),
		})
	}
	return out
}

func getInputFilesFieldWithFallback(xr, observedXR *resource.Composite, path string) []inputFile {
	if xr != nil {
		if value := getInputFilesField(xr.Resource.Object, path); len(value) > 0 {
			return value
		}
	}
	if observedXR != nil {
		return getInputFilesField(observedXR.Resource.Object, path)
	}
	return nil
}

func getOutputArtifactsField(obj map[string]any, path string) []outputArtifact {
	rawItems := getListField(obj, path)
	if rawItems == nil {
		return nil
	}
	out := make([]outputArtifact, 0, len(rawItems))
	for _, raw := range rawItems {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, outputArtifact{
			Name: getStringValue(entry["name"]),
			Path: getStringValue(entry["path"]),
		})
	}
	return out
}

func getOutputArtifactsFieldWithFallback(xr, observedXR *resource.Composite, path string) []outputArtifact {
	if xr != nil {
		if value := getOutputArtifactsField(xr.Resource.Object, path); len(value) > 0 {
			return value
		}
	}
	if observedXR != nil {
		return getOutputArtifactsField(observedXR.Resource.Object, path)
	}
	return nil
}

func getListField(obj map[string]any, path string) []any {
	if obj == nil {
		return nil
	}
	value, err := fieldpath.Pave(obj).GetValue(path)
	if err != nil {
		return nil
	}
	items, _ := value.([]any)
	return items
}

func getStringValue(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	return ""
}
