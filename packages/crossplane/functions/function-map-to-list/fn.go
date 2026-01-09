package main

import (
	"context"
	"fmt"
	"sort"

	"github.com/crossplane/crossplane-runtime/v2/pkg/fieldpath"
	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"

	"github.com/crossplane/function-map-to-list/input/v1alpha1"
)

// Function maps a fieldpath map into a list on a composed resource.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

// RunFunction runs the Function.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	in := &v1alpha1.MapToList{}
	if err := request.GetInput(req, in); err != nil {
		response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
		return rsp, nil
	}

	if in.Spec.FromFieldPath == "" || in.Spec.ToResource == "" || in.Spec.ToFieldPath == "" {
		response.Fatal(rsp, errors.New("spec.fromFieldPath, spec.toResource, and spec.toFieldPath are required"))
		return rsp, nil
	}

	nameField := in.Spec.ListKeys.NameField
	if nameField == "" {
		nameField = "name"
	}
	valueField := in.Spec.ListKeys.ValueField
	if valueField == "" {
		valueField = "value"
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

	raw, err := fieldpath.Pave(xr.Resource.Object).GetValue(in.Spec.FromFieldPath)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read fromFieldPath"))
		return rsp, nil
	}

	asMap, ok := raw.(map[string]any)
	if raw == nil {
		asMap = map[string]any{}
		ok = true
	}
	if !ok {
		response.Fatal(rsp, errors.Errorf("fromFieldPath %q is not a map", in.Spec.FromFieldPath))
		return rsp, nil
	}

	keys := make([]string, 0, len(asMap))
	for key := range asMap {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]any, 0, len(keys))
	for _, key := range keys {
		items = append(items, map[string]any{
			nameField:  key,
			valueField: fmt.Sprint(asMap[key]),
		})
	}

	target, ok := dcds[resource.Name(in.Spec.ToResource)]
	if !ok {
		response.Fatal(rsp, errors.Errorf("desired resource %q not found", in.Spec.ToResource))
		return rsp, nil
	}

	if err := fieldpath.Pave(target.Resource.Object).SetValue(in.Spec.ToFieldPath, items); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set toFieldPath"))
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
