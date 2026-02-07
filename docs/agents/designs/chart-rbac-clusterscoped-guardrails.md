# Chart RBAC Cluster-Scoped Guardrails

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
The Agents chart can run with cluster-scoped RBAC (`rbac.clusterScoped=true`) or namespaced RBAC (`false`). Misconfiguration can lead to controller errors (insufficient permissions) or excessive permissions (overbroad access).

This doc defines guardrails in chart schema and controller startup validation.

## Goals
- Prevent mismatched RBAC and controller namespace scope.
- Provide predictable permission sets for production.
- Make RBAC mode visible in runtime logs and `/health` output.

## Non-Goals
- Enforcing organization-wide RBAC standards beyond this chart.

## Current State
- Values: `charts/agents/values.yaml` has `rbac.clusterScoped`.
- Chart templates:
  - RBAC objects: `charts/agents/templates/rbac.yaml`
  - Controllers deployment exports `JANGAR_RBAC_CLUSTER_SCOPED`: `charts/agents/templates/deployment-controllers.yaml`
- Runtime uses `JANGAR_RBAC_CLUSTER_SCOPED` when deciding listing/watching behavior: `services/jangar/src/server/*` (notably `kube-watch.ts` and namespace helpers).
- GitOps uses `rbac.clusterScoped: false` in `argocd/applications/agents/values.yaml`.

## Design
### Guardrail matrix
- If `rbac.clusterScoped=false`:
  - `controller.namespaces` MUST be non-empty and MUST NOT include `\"*\"`.
- If `rbac.clusterScoped=true`:
  - `controller.namespaces` MAY be wildcard `\"*\"` or a list (for partial scope), but RBAC remains cluster-wide.

### Validation points
- Chart render-time validation in `charts/agents/templates/validation.yaml`.
- Controller startup validation:
  - Log `clusterScoped` and resolved namespaces.
  - If `clusterScoped=false` but namespaces is empty: exit non-zero with actionable error.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `rbac.clusterScoped=false` | `JANGAR_RBAC_CLUSTER_SCOPED=false` | Controllers restrict API calls to configured namespaces only. |
| `rbac.clusterScoped=true` | `JANGAR_RBAC_CLUSTER_SCOPED=true` | Controllers may list/watch across namespaces (when configured). |

## Rollout Plan
1. Add schema validation for common misconfigs (no behavior change for correct installs).
2. Add controller startup log lines and warnings first.
3. Promote warnings to fail-fast once canary confirms no hidden dependencies.

Rollback:
- Disable validation rules and keep RBAC objects unchanged.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"ClusterRole|Role|clusterScoped\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_RBAC_CLUSTER_SCOPED\"
```

## Failure Modes and Mitigations
- Controllers get RBAC forbidden errors: mitigate by surfacing `clusterScoped` and scope in logs and health.
- Overbroad RBAC accidentally enabled: mitigate by defaulting `clusterScoped=false` and adding schema warnings for prod overlays.

## Acceptance Criteria
- Invalid RBAC/scope combinations are rejected at render time.
- Runtime logs clearly indicate RBAC mode and namespace scope.

## References
- Kubernetes RBAC overview: https://kubernetes.io/docs/reference/access-authn-authz/rbac/

