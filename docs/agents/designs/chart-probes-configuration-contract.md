# Chart Probes Configuration Contract

Status: Draft (2026-02-06)

## Overview
The chart exposes HTTP liveness/readiness probe settings for the control plane, but probes may not be appropriate for controllers (which may not expose HTTP) and there is no startup probe for long initialization (e.g., cache warmup).

This doc defines probe semantics per component and proposes adding startup probes and per-component overrides.

## Goals
- Ensure probes correctly reflect component health.
- Avoid flapping restarts due to aggressive liveness probes.
- Support long startups without false negatives.

## Non-Goals
- Defining SLOs or alerting policies.

## Current State
- Values: `charts/agents/values.yaml` has `livenessProbe` and `readinessProbe`.
- Templates:
  - Control plane probes: `charts/agents/templates/deployment.yaml` (HTTP GET to `.Values.*Probe.path` on `port: http`).
  - Controllers probes: currently inherited similarly (if present) depending on the template structure in `deployment-controllers.yaml` (needs explicit review when adding).
- No startupProbe values exist.

## Design
### Component-specific probes
Add:
- `controlPlane.livenessProbe`, `controlPlane.readinessProbe`, `controlPlane.startupProbe`
- `controllers.livenessProbe`, `controllers.readinessProbe`, `controllers.startupProbe`

### Defaults
- Control plane:
  - readiness: `/health` (existing)
  - liveness: `/health` (existing)
  - startup: enabled with higher thresholds to tolerate migrations/cold start
- Controllers:
  - Prefer a simple HTTP `/health` endpoint if available; otherwise allow exec-based probe or disable probes explicitly.

## Config Mapping
| Helm value | Rendered probe | Intended behavior |
|---|---|---|
| `controlPlane.readinessProbe.path` | readinessProbe.httpGet.path | Control plane only. |
| `controllers.startupProbe.*` | startupProbe (http/exec) | Prevent premature restarts during controller initialization. |

## Rollout Plan
1. Add new component probe keys; default them to current global values for control plane.
2. Verify controllers have a stable health endpoint (or disable probes explicitly).
3. Tune thresholds based on observed rollout behavior.

Rollback:
- Remove component overrides and rely on existing global probes.

## Validation
```bash
helm template agents charts/agents | rg -n \"livenessProbe:|readinessProbe:|startupProbe:\"
kubectl -n agents describe pod -l app.kubernetes.io/name=agents | rg -n \"Liveness|Readiness|Startup\"
```

## Failure Modes and Mitigations
- Liveness probe too strict causes restart loops: mitigate with startupProbe + relaxed thresholds.
- Readiness probe too lax sends traffic to an unready control plane: mitigate by tying readiness to dependency checks in code.

## Acceptance Criteria
- Control plane and controllers can be configured independently.
- StartupProbe prevents false liveness failures during initialization.

## References
- Kubernetes probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/


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
