# Controller Reconcile Timeout Budget

Status: Draft (2026-02-06)

## Overview
Agents controllers perform multiple external operations during reconciliation (Kubernetes API calls via `kubectl`, VCS calls, webhook parsing, database operations). Today, timeouts are mostly implicit (subprocess defaults, library defaults), which makes tail-latency and hung reconciles hard to diagnose.

This doc proposes explicit, configurable timeout budgets for key controller operations.

## Goals
- Make controller timeouts explicit and configurable.
- Prevent a single hung subprocess/API call from stalling reconciliation.
- Provide clear failure behavior and retry guidance.

## Non-Goals
- Changing controller concurrency/throughput policies (covered elsewhere).

## Current State
- Kubernetes calls are executed via spawned `kubectl` processes:
  - `services/jangar/src/server/primitives-kube.ts` (`runCommand`, `kubectl(...)`)
  - Watch loop uses `kubectl get --watch`: `services/jangar/src/server/kube-watch.ts` (uses `--request-timeout=0`)
- Controllers orchestration submission touches the DB store and Kubernetes: `services/jangar/src/server/orchestration-submit.ts`.
- Helm templates do not set any timeout env vars beyond existing feature toggles: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Proposed env vars (controllers only)
- `JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` (default `30000`)
- `JANGAR_CONTROLLER_DB_TIMEOUT_MS` (default `15000`)
- `JANGAR_CONTROLLER_EXTERNAL_TIMEOUT_MS` (default `30000`) for provider calls/webhooks where applicable

### Implementation sketch
- Wrap `runCommand()` in `primitives-kube.ts` with an `AbortController`/timer and kill the child process on timeout.
- Ensure timeout errors:
  - Have a stable `reason`/prefix (e.g. `Timeout: kubectl apply exceeded ...`) for log filtering.
  - Are classified as retryable vs non-retryable (see Failure Modes).

## Config Mapping
| Helm value (proposed) | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` | `JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` | Upper bound for `kubectl` subprocess calls. |
| `controllers.env.vars.JANGAR_CONTROLLER_DB_TIMEOUT_MS` | `JANGAR_CONTROLLER_DB_TIMEOUT_MS` | Upper bound for DB operations in controller flows. |

## Rollout Plan
1. Add env var support with defaults that match current practical behavior (no effective change).
2. Canary in non-prod by injecting an artificial delay and confirming timeouts trip.
3. Tune defaults based on observed p95/p99.

Rollback:
- Set timeouts to a high value (or remove env vars) to approximate current behavior.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_CONTROLLER_.*TIMEOUT\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"Timeout:\"
```

## Failure Modes and Mitigations
- Timeout too low causes flakey reconciles: mitigate by conservative defaults + per-environment overrides.
- Timeout too high hides hangs: mitigate by explicit budgets and warnings at 80% of budget.
- `kubectl` process leaks on timeout: mitigate by kill + wait + defensive cleanup.

## Acceptance Criteria
- A hung `kubectl` call cannot stall reconciliation indefinitely.
- Operators can tune timeout budgets via Helm values.

## References
- Kubernetes API timeouts (client-side considerations): https://kubernetes.io/docs/reference/using-api/api-concepts/

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
