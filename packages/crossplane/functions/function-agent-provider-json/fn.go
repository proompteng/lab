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

	dcds, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return rsp, nil
	}

	providerName := ""
	if xr != nil && xr.Resource != nil {
		providerName = xr.Resource.GetName()
	}

	binary := getStringField(xr.Resource.Object, "spec.binary")
	if binary == "" {
		response.Fatal(rsp, errors.New("spec.binary is required"))
		return rsp, nil
	}

	spec := providerSpec{
		Name:            providerName,
		Binary:          binary,
		ArgsTemplate:    getStringSliceField(xr.Resource.Object, "spec.argsTemplate"),
		EnvTemplate:     getStringMapField(xr.Resource.Object, "spec.envTemplate"),
		InputFiles:      getInputFilesField(xr.Resource.Object, "spec.inputFiles"),
		OutputArtifacts: getOutputArtifactsField(xr.Resource.Object, "spec.outputArtifacts"),
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
