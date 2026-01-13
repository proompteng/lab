//go:build generate
// +build generate

//go:generate bash -c "go run -tags generate sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.0 paths=./v1alpha1 object crd:crdVersions=v1 output:artifacts:config=../../../../charts/agents/crds && python3 ../../../../scripts/agents/patch-crds.py ../../../../charts/agents/crds"

package agents

import (
	_ "sigs.k8s.io/controller-tools/cmd/controller-gen" //nolint:typecheck
)
