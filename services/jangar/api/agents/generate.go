//go:build generate
// +build generate

//go:generate go run -tags generate sigs.k8s.io/controller-tools/cmd/controller-gen paths=./v1alpha1 object crd:crdVersions=v1 output:artifacts:config=../../../../charts/agents/crds

package agents

import (
	_ "sigs.k8s.io/controller-tools/cmd/controller-gen" //nolint:typecheck
)
