# Chart Config Checksum Rollouts

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

## Overview
Kubernetes does not automatically restart pods when referenced Secrets/ConfigMaps change (especially when referenced via env vars). In GitOps environments, this frequently leads to “updated Secret, pods still using old value” incidents.

This doc proposes checksum annotations to trigger Deployment rollouts when selected config inputs change.

## Goals
- Provide an opt-in mechanism to restart control plane/controllers when key Secrets/ConfigMaps change.
- Make the behavior explicit and easy to validate in Helm renders.

## Non-Goals
- Automatically restarting on all Secrets/ConfigMaps in the namespace.

## Current State
- Chart references:
  - DB URL Secret: `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml`
  - `envFromSecretRefs` / `envFromConfigMapRefs`: same templates
- No checksum annotations exist in pod templates.

## Design
### Proposed values
Add:
- `rolloutChecksums.enabled` (default `false`)
- `rolloutChecksums.secrets: []`
- `rolloutChecksums.configMaps: []`

When enabled, annotate pod templates with:
- `checksum/secret/<name>: <sha256>`
- `checksum/configmap/<name>: <sha256>`

### Implementation detail
- Hash the rendered Secret/ConfigMap data when defined in-chart, and the name only (or `lookup`) when managed externally.
  - In GitOps, `lookup` behavior varies; prefer explicit operator-provided checksums when needed.

## Config Mapping
| Helm value | Rendered annotation | Intended behavior |
|---|---|---|
| `rolloutChecksums.enabled=true` | `checksum/*` annotations | Any change triggers a Deployment rollout. |
| `rolloutChecksums.secrets=[\"agents-github-token-env\"]` | `checksum/secret/agents-github-token-env` | Restart when the referenced Secret changes. |

## Rollout Plan
1. Add feature behind `rolloutChecksums.enabled=false`.
2. Enable in non-prod with one Secret (e.g. GitHub token) to validate.
3. Enable in prod after validating rollout behavior and avoiding excessive restarts.

Rollback:
- Disable the flag; annotation removal stops checksum-triggered rollouts.

## Validation
```bash
helm template agents charts/agents | rg -n \"checksum/\"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

## Failure Modes and Mitigations
- Too many checksum sources cause frequent rollouts: mitigate with explicit allowlist and opt-in.
- Checksum cannot be computed for external Secrets: mitigate by allowing user-provided checksum values.

## Acceptance Criteria
- Enabling the feature causes a deterministic rollout on config changes.
- Operators can scope restarts to a small list of critical Secrets/ConfigMaps.

## References
- Kubernetes ConfigMaps/Secrets update behavior: https://kubernetes.io/docs/concepts/configuration/configmap/

