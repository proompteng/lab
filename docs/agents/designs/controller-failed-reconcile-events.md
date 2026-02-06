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
- Controller implementation: `services/jangar/src/server/agents-controller.ts`
- Supporting controllers:
  - Orchestration: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks: `services/jangar/src/server/primitives-policy.ts`
- Chart env var wiring (controllers deployment): `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state: `argocd/applications/agents/values.yaml` (inputs to chart)

### Values → env var mapping (controllers)
- `controller.*` values in `charts/agents/values.yaml` map to `JANGAR_AGENTS_CONTROLLER_*` env vars in `charts/agents/templates/deployment-controllers.yaml`.
- The controller reads env via helpers like `parseEnvStringList`, `parseEnvRecord`, `parseJsonEnv` in `services/jangar/src/server/agents-controller.ts`.

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

### Rollout plan
1. Update controller code under `services/jangar/src/server/`.
2. Build/push image(s) (out of scope in this doc set); then update GitOps pins:
   - `argocd/applications/agents/values.yaml` (controllers/control plane images)
   - `argocd/applications/jangar/kustomization.yaml` (product `jangar` image)
3. Merge to `main`; Argo CD reconciles.

### Validation
- Unit tests (fast): `bun run --filter jangar test`
- Render desired manifests (no cluster needed):

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
```

- Live cluster (requires kubeconfig): see commands in “Current cluster state” above.
