# Chart Controller Namespaces: Empty Semantics

Status: Draft (2026-02-06)

## Overview
Controllers reconcile CRDs in a set of namespaces. The chart exposes `controller.namespaces`, but it’s easy for operators to assume an empty list might mean “disabled” or “all namespaces”. In practice, the chart and controllers implement concrete (and mostly safe) defaulting rules, but they must be documented explicitly because namespace scoping is a primary safety boundary.

## Goals
- Document the actual meaning for `controller.namespaces: []` / unset.
- Prevent accidental cluster-wide reconciliation in namespaced installs (RBAC + wildcard).
- Make namespace scope observable and testable.

## Non-Goals
- Redesigning multi-namespace support (covered separately).

## Current State
- Values: `charts/agents/values.yaml` exposes `controller.namespaces: []`.
- Template defaulting (chart source of truth):
  - `charts/agents/templates/_helpers.tpl` (`agents.controllerNamespaces`) treats an empty/absent list as “the release namespace” (or `namespaceOverride` if set) and joins namespaces as a comma-separated string.
  - That helper is used to render:
    - `JANGAR_AGENTS_CONTROLLER_NAMESPACES`: `charts/agents/templates/deployment.yaml` and `charts/agents/templates/deployment-controllers.yaml`
    - `JANGAR_PRIMITIVES_NAMESPACES`: same templates
- Runtime parsing (controller source of truth):
  - `services/jangar/src/server/agents-controller.ts:260` parses `JANGAR_AGENTS_CONTROLLER_NAMESPACES` as a comma-separated list and defaults to `DEFAULT_NAMESPACES=['agents']` only when the env var is missing/empty.
  - Wildcard semantics: `services/jangar/src/server/agents-controller.ts:278` supports `'*'` (list namespaces via kubectl) and enforces `rbac.clusterScoped=true` via `services/jangar/src/server/namespace-scope.ts:11`.
- Cluster desired state (GitOps): `argocd/applications/agents/values.yaml` sets `controller.namespaces: [agents]` explicitly.

## Design
### Semantics
- **Empty/unset** `controller.namespaces` means: “use the release namespace” (or `namespaceOverride`). This is the current behavior implemented by `agents.controllerNamespaces` and is the recommended safe default for namespaced installs.
- **Explicit list** means: reconcile only those namespaces.
- **Wildcard** `'*'` means: reconcile all namespaces, but only when `rbac.clusterScoped=true` (enforced at runtime).

If future behavior changes are desired, do not reinterpret the empty list. Instead:
- Introduce an explicit disable flag (e.g. `controller.enabled=false`) or a dedicated “none” sentinel.
- Keep wildcard as the only “all namespaces” mechanism and continue to require cluster-scoped RBAC.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces: ['agents']` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=agents` | Reconcile only `agents` namespace resources. |
| `controller.namespaces: []` (or unset) | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=<release-namespace>` | Reconcile only the release namespace (or `namespaceOverride`). |
| `controller.namespaces: ['*']` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=*` | (When `rbac.clusterScoped=true`) reconcile all namespaces (runtime lists namespaces via kubectl). |

## Rollout Plan
1. Document semantics (this doc) and point operators to the actual helper and runtime parsing functions.
2. (Optional hardening) Add chart schema constraints in `charts/agents/values.schema.json`:
   - Reject `controller.namespaces: ['*']` when `rbac.clusterScoped=false`.
   - Prefer explicit `controller.namespaces` in GitOps overlays for clarity (even though empty defaults safely).

Rollback:
- N/A (doc/schema-only).

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"NAMESPACES|namespace\"
```

## Failure Modes and Mitigations
- Empty list assumed to mean “all namespaces”: mitigate by documenting the real behavior and avoiding implicit wildcarding.
- Wildcard scope used with namespaced RBAC: mitigate by runtime guard (`assertClusterScopedForWildcard`) and (optional) schema validation.

## Acceptance Criteria
- Empty/unset namespaces behavior is explicitly documented and matches `agents.controllerNamespaces` (release namespace defaulting).
- Wildcard all-namespaces requires explicit `'*'` and cluster-scoped RBAC (runtime-enforced).

## References
- Kubernetes controller patterns (namespace scoping best practices): https://kubernetes.io/docs/concepts/architecture/controller/


## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
