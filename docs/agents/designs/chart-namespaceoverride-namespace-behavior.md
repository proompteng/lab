# Chart namespaceOverride vs Release Namespace Behavior

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
The chart uses `namespaceOverride` to force all rendered resources into a namespace different from `.Release.Namespace`. This is useful in some GitOps setups but can be hazardous if only part of a release is overridden (e.g. CRDs are cluster-scoped, but Roles/RoleBindings are namespaced).

This doc defines safe usage and guardrails.

## Goals
- Make namespace selection behavior explicit for all chart resources.
- Prevent accidental “split-brain” installs (resources in multiple namespaces).

## Non-Goals
- Supporting multi-namespace installs from a single Helm release.

## Current State
- Value: `charts/agents/values.yaml` → `namespaceOverride`.
- Most templates set `metadata.namespace: {{ .Values.namespaceOverride | default .Release.Namespace }}`:
  - Examples: `charts/agents/templates/deployment.yaml`, `charts/agents/templates/service.yaml`, `charts/agents/templates/rbac.yaml`.
- GitOps typically installs into namespace `agents` and does not set `namespaceOverride` explicitly.

## Design
### Contract
- If `namespaceOverride` is set, it MUST be used consistently across all namespaced resources in the chart.
- Chart MUST fail render if:
  - `namespaceOverride` is set to an empty/whitespace string.
  - `namespaceOverride` is set but `.Release.Namespace` differs and `createNamespace=false` (optional guardrail depending on GitOps practice).

### Documentation requirement
Add a README section:
- “Do not set `namespaceOverride` unless Argo/Helm release namespace is locked.”

## Config Mapping
| Helm value | Rendered namespace | Intended behavior |
|---|---|---|
| `namespaceOverride: \"\"` | `.Release.Namespace` | Normal Helm behavior. |
| `namespaceOverride: agents` | `agents` | Forces all namespaced resources into `agents`. |

## Rollout Plan
1. Document contract and guardrails.
2. Add schema validation (`minLength: 1` when set).
3. Add template validation for common foot-guns.

Rollback:
- Remove `namespaceOverride`; rely on `.Release.Namespace`.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"namespace:\"
kubectl get ns agents
```

## Failure Modes and Mitigations
- Resources created in unexpected namespace: mitigate via render review + guardrail validation.
- Argo CD app sync fails due to namespace mismatch: mitigate by keeping release namespace and override aligned.

## Acceptance Criteria
- Rendered manifests place all namespaced resources in exactly one namespace.
- Invalid override values are rejected at render time.

## References
- Helm template rendering concepts: https://helm.sh/docs/chart_template_guide/

