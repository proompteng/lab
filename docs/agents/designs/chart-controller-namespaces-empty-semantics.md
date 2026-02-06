# Chart Controller Namespaces: Empty Semantics

Status: Draft (2026-02-06)

## Overview
Controllers reconcile CRDs in a set of namespaces. The chart exposes `controller.namespaces`, but it is not documented what an empty list means (disabled? all namespaces? release namespace only?). Ambiguity here creates production risk.

## Goals
- Define an explicit meaning for `controller.namespaces: []`.
- Prevent accidental cluster-wide reconciliation in namespaced installs.
- Make namespace scope observable and testable.

## Non-Goals
- Redesigning multi-namespace support (covered separately).

## Current State
- Values: `charts/agents/values.yaml` exposes `controller.namespaces: []`.
- Template renders namespaces into env vars:
  - `JANGAR_AGENTS_CONTROLLER_NAMESPACES`: `charts/agents/templates/deployment-controllers.yaml`
  - helper: `charts/agents/templates/_helpers.tpl` (`agents.controllerNamespaces`)
- Runtime parsing:
  - `services/jangar/src/server/implementation-source-webhooks.ts` reads `process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES`.
  - Controllers use namespace scoping utilities in `services/jangar/src/server/namespace-scope.ts`.
- Cluster desired state sets `controller.namespaces: [agents]` in `argocd/applications/agents/values.yaml`.

## Design
### Semantics
- `controller.namespaces` MUST be required when `rbac.clusterScoped=false`.
- Empty list MUST mean “no namespaces configured” and controllers SHOULD refuse to start (fail-fast) to avoid a false sense of safety.
- For `rbac.clusterScoped=true`, introduce an explicit value:
  - `controller.namespaces: [\"*\"]` to mean “all namespaces”, rather than interpreting empty as all.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces: [\"agents\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"agents\"]` | Reconcile only `agents` namespace resources. |
| `controller.namespaces: []` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[]` (or unset) | Fail-fast at startup unless clusterScoped=true and explicit wildcard used. |
| `controller.namespaces: [\"*\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"*\"]` | (When clusterScoped=true) reconcile all namespaces. |

## Rollout Plan
1. Document semantics and recommend non-empty namespaces for prod.
2. Add controller startup validation in `services/jangar/src/server/*`:
   - If env var is empty/unset: exit with clear error.
3. Add chart schema rule: when `controller.enabled=true`, require at least one namespace unless clusterScoped=true and wildcard is used.

Rollback:
- Disable fail-fast validation (code rollback).

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"NAMESPACES|namespace\"
```

## Failure Modes and Mitigations
- Empty list interpreted as “all namespaces” unexpectedly: mitigate by banning that interpretation.
- Controllers start but do nothing due to empty scope: mitigate with fail-fast.
- Wildcard scope used with namespaced RBAC: mitigate by schema validation and startup checks.

## Acceptance Criteria
- Empty namespaces configuration is rejected with a clear, actionable error.
- Wildcard all-namespaces requires explicit `\"*\"` and cluster-scoped RBAC.

## References
- Kubernetes controller patterns (namespace scoping best practices): https://kubernetes.io/docs/concepts/architecture/controller/

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart behavior: `charts/agents/values.yaml`, `charts/agents/values.schema.json`, `charts/agents/templates/`
- Chart render-time validation: `charts/agents/templates/validation.yaml`
- GitOps desired state:
  - `agents` app (CRDs + controllers + service): `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
  - `jangar` app (product deployment + primitives): `argocd/applications/jangar/kustomization.yaml`
  - Product enablement: `argocd/applicationsets/product.yaml`

### Values → env var mapping (chart)
- Control plane env var merge + rendering: `charts/agents/templates/deployment.yaml`
- Controllers env var merge + rendering: `charts/agents/templates/deployment-controllers.yaml`
- Common pattern: `.Values.env.vars` are merged with component-specific vars (control plane: `.Values.controlPlane.env.vars`, controllers: `.Values.controllers.env.vars`). Component-specific keys win.

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`, desired state in Git):
- `agents` Argo CD app (namespace `agents`) installs `charts/agents` via kustomize-helm (release `agents`, chart `version: 0.9.1`, `includeCRDs: true`). See `argocd/applications/agents/kustomization.yaml`.
- Images pinned for `agents`:
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` (from `controlPlane.image.*`).
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809` (from `image.*`).
- Namespaced reconciliation: `controller.namespaces: [agents]`, `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- `jangar` Argo CD app (namespace `jangar`) deploys the product UI/control plane plus default “primitive” CRs (AgentProvider/Agent/Memory/etc). See `argocd/applications/jangar/kustomization.yaml`.
- Jangar image pinned for `jangar` (`deploy/jangar`): `registry.ide-newton.ts.net/lab/jangar:19448656@sha256:15380bb91e2a1bb4e7c59dce041859c117ceb52a873d18c9120727c8e921f25c` (from `argocd/applications/jangar/kustomization.yaml`).

Render the exact YAML Argo CD applies:

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/jangar > /tmp/jangar.rendered.yaml
```

Verify live cluster state (requires kubeconfig):

```bash
mise exec kubectl@1.30.6 -- kubectl get application -n argocd agents
mise exec kubectl@1.30.6 -- kubectl get application -n argocd jangar
mise exec kubectl@1.30.6 -- kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
mise exec kubectl@1.30.6 -- kubectl get deploy -n agents
mise exec kubectl@1.30.6 -- kubectl get deploy -n jangar
mise exec kubectl@1.30.6 -- kubectl get crd | rg 'proompteng\.ai'
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl rollout status -n jangar deploy/jangar
```

### Rollout plan (GitOps)
1. Change chart templates/values/schema in `charts/agents/**`.
2. If the chart `version:` changes, keep `charts/agents/Chart.yaml` and `argocd/applications/agents/kustomization.yaml` in sync.
3. Validate rendering locally (no cluster access required):

```bash
mise exec helm@3.15.4 -- helm lint charts/agents
mise exec helm@3.15.4 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml --include-crds > /tmp/agents.helm.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
scripts/agents/validate-agents.sh
```

4. Merge to `main`; Argo CD reconciles.

### Validation (post-merge)
- Confirm Argo sync + workloads healthy:

```bash
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl logs -n agents deploy/agents-controllers --tail=200
```
