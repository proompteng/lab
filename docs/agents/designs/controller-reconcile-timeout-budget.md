# Controller Reconcile Timeout Budget

Status: Draft (2026-02-07)

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
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
