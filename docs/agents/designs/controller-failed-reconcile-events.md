# Controller Failed Reconcile: Kubernetes Events

Status: Draft (2026-02-06)

## Overview
When reconciles fail, the current primary signal is logs (and possibly status conditions). Kubernetes Events are a useful operational tool (visible via `kubectl describe`) and can improve MTTR, especially for failures like missing secrets, RBAC, or invalid spec fields.

## Goals
- Emit Kubernetes Events for actionable reconcile failures.
- Avoid noisy event storms for transient errors.

## Non-Goals
- Replacing logs or status conditions.

## Current State
- Controllers update status for many CRDs via `setStatus(...)` helpers:
  - `services/jangar/src/server/agents-controller.ts`
  - `services/jangar/src/server/implementation-source-webhooks.ts` (status updates)
- Kubernetes client wrapper currently supports listing Events but not creating them:
  - `services/jangar/src/server/primitives-kube.ts` includes `listEvents(...)` but no `createEvent(...)`.
- The chart does not configure event emission.

## Design
### Event emission rules
- For non-retryable spec/config errors:
  - Emit `Warning` event with a stable reason (e.g. `InvalidSpec`, `MissingSecret`, `Forbidden`).
- For transient errors:
  - Update status condition + log; emit an event only on first occurrence and then rate-limit (per-object).

### Implementation approach
- Extend `KubernetesClient` in `primitives-kube.ts` to support creating Events:
  - Use `events.k8s.io/v1` if available; fall back to `v1` Events if necessary.
- Add an event helper in controllers to avoid duplication and to enforce rate limiting.

## Config Mapping
| Helm value (proposed) | Env var (proposed) | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_ENABLED` | `JANGAR_CONTROLLER_EVENTS_ENABLED` | Enables/disables event emission (default `true`). |
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | `JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | Caps event spam per object. |

## Rollout Plan
1. Add event emission behind `JANGAR_CONTROLLER_EVENTS_ENABLED=true` with conservative rate limits.
2. Canary in non-prod and confirm event volume is manageable.
3. Enable in prod; document common reasons in runbooks.

Rollback:
- Set `JANGAR_CONTROLLER_EVENTS_ENABLED=false`.

## Validation
```bash
kubectl -n agents get events --sort-by=.metadata.creationTimestamp | tail -n 50
kubectl -n agents describe agentrun <name> | rg -n \"Events:\"
```

## Failure Modes and Mitigations
- Event storms during reconcile loops: mitigate with strict per-object rate limiting and “first occurrence only” logic.
- Events leak sensitive info: mitigate by sanitizing messages and never including secret values.

## Acceptance Criteria
- Non-retryable spec errors produce a Kubernetes Event with a stable reason.
- Event volume remains bounded under failure conditions.

## References
- Kubernetes Events: https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#event-v1-core


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
