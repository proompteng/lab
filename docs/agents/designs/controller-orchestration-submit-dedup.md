# Orchestration Submit Deduplication (Delivery ID)

Status: Draft (2026-02-06)

## Overview
Orchestration run submission is triggered by external events (e.g., webhooks). Duplicate deliveries are common. The current system deduplicates submissions by `deliveryId` using the primitives store.

This doc formalizes the dedupe contract and proposes chart/controller knobs to keep it safe in production.

## Goals
- Guarantee idempotent orchestration submissions per `(namespace, orchestrationRef, deliveryId)`.
- Ensure dedupe state is durable across controller restarts.

## Non-Goals
- Exactly-once processing across multiple clusters.

## Current State
- Submission code: `services/jangar/src/server/orchestration-submit.ts`
  - Looks up `store.getOrchestrationRunByDeliveryId(input.deliveryId)` and returns existing run if present.
  - Applies an `OrchestrationRun` resource with label `jangar.proompteng.ai/delivery-id`.
- Store layer: `services/jangar/src/server/primitives-store.ts` (durable DB-backed store).
- Chart wiring for DB URL is required for controllers: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Contract
- `deliveryId` MUST be treated as globally unique per provider.
- If a duplicate `deliveryId` is received:
  - Return the existing `OrchestrationRun` record and (if present) the external CR state.
- Dedupe retention:
  - Keep dedupe records for a minimum window (e.g. 7 days) to handle delayed retries.

### Proposed config
- `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` (default `7`)
- Store cleanup job (optional) to prune old dedupe rows.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | How long to retain dedupe records. |

## Rollout Plan
1. Document dedupe semantics and label usage.
2. Add retention config and a safe default.
3. Add a periodic cleanup job (optional) once validated in staging.

Rollback:
- Disable cleanup job and keep retention high.

## Validation
```bash
kubectl -n agents get orchestrationrun -l jangar.proompteng.ai/delivery-id --show-labels
kubectl -n agents logs deploy/agents-controllers | rg -n \"deliveryId|idempotent\"
```

## Failure Modes and Mitigations
- Dedupe table grows unbounded: mitigate with retention + cleanup job.
- deliveryId collisions between providers: mitigate by namespacing deliveryId with provider prefix if needed.

## Acceptance Criteria
- Duplicate deliveries do not create duplicate orchestration runs.
- Dedupe state survives controller restarts.

## References
- HTTP request idempotency (general definition): https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods

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
