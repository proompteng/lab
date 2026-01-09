package main

import (
	"context"
	"strconv"
	"strings"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/crossplane/function-memory-sql/input/v1alpha1"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
)

const defaultEmbeddingsDimension = 1536

// Function renders SQL templates for the Memory composition.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

// RunFunction runs the Function.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.MemorySqlRender{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.TargetConfigMap == "" || in.Spec.SqlKey == "" || in.Spec.EmbeddingsDimensionFieldPath == "" {
		response.Fatal(rsp, errors.New("spec.targetConfigMap, spec.sqlKey, and spec.embeddingsDimensionFieldPath are required"))
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

	dimension := defaultEmbeddingsDimension
	if raw, err := fieldpath.Pave(xr.Resource.Object).GetValue(in.Spec.EmbeddingsDimensionFieldPath); err == nil {
		switch value := raw.(type) {
		case int:
			dimension = value
		case int32:
			dimension = int(value)
		case int64:
			dimension = int(value)
		case float64:
			dimension = int(value)
		case string:
			if parsed, parseErr := strconv.Atoi(value); parseErr == nil {
				dimension = parsed
			}
		}
	}

	target, ok := dcds[resource.Name(in.Spec.TargetConfigMap)]
	if !ok {
		response.Fatal(rsp, errors.Errorf("desired resource %q not found", in.Spec.TargetConfigMap))
		return rsp, nil
	}

	data, found, err := unstructured.NestedStringMap(target.Resource.Object, "data")
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read configmap data"))
		return rsp, err
	}
	if !found {
		response.Fatal(rsp, errors.Errorf("configmap %q missing data field", in.Spec.TargetConfigMap))
		return rsp, nil
	}

	sql, ok := data[in.Spec.SqlKey]
	if !ok {
		response.Fatal(rsp, errors.Errorf("configmap %q missing sql key %q", in.Spec.TargetConfigMap, in.Spec.SqlKey))
		return rsp, nil
	}

	rendered := strings.ReplaceAll(sql, "{{EMBEDDINGS_DIMENSION}}", strconv.Itoa(dimension))
	data[in.Spec.SqlKey] = rendered

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
