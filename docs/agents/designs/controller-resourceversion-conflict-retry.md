# Controller ResourceVersion Conflicts and Retry Strategy

Status: Draft (2026-02-06)

## Overview
Controllers patch and apply resources that may also be updated by other actors (users, GitOps, other controllers). Conflicts (HTTP 409) and optimistic concurrency failures should be handled predictably: retry when safe, fail fast when not.

## Goals
- Define a retry policy for resourceVersion conflicts on:
  - status writes
  - metadata patches (finalizers/labels)
- Avoid infinite retry loops.

## Non-Goals
- Solving every conflict scenario; some must surface as errors.

## Current State
- Controllers patch and set status frequently:
  - `services/jangar/src/server/agents-controller.ts` uses `kube.patch(...)` and `setStatus(...)`.
- `kube.patch` uses `kubectl patch --type=merge`:
  - `services/jangar/src/server/primitives-kube.ts`
- Conflict handling is not centralized; retries are largely implicit (if reconciliation loops run again).

## Design
### Retry policy
- For status updates:
  - Use SSA where possible (reduces conflicts) and retry up to N times with jitter on conflict.
- For metadata patches (finalizers):
  - Retry up to N times on conflict; if still conflicting, re-fetch and recompute finalizers.
- N defaults to 3, configurable via env var.

### Implementation approach
- Add a `withConflictRetry` helper used by:
  - finalizer patch paths in `agents-controller.ts`
  - status apply paths (if not already resilient)

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_CONFLICT_RETRY_ATTEMPTS` | `JANGAR_CONTROLLER_CONFLICT_RETRY_ATTEMPTS` | Max retries on 409/conflict (default `3`). |
| `controllers.env.vars.JANGAR_CONTROLLER_CONFLICT_RETRY_BASE_MS` | `JANGAR_CONTROLLER_CONFLICT_RETRY_BASE_MS` | Base backoff delay (default `200`). |

## Rollout Plan
1. Add helper + defaults (no config needed).
2. Canary in non-prod by simulating concurrent updates and confirming convergence.

Rollback:
- Disable retries by setting attempts to `0` (or reverting code).

## Validation
```bash
kubectl -n agents get agentrun <name> -o yaml | rg -n \"resourceVersion:\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"Conflict|409\"
```

## Failure Modes and Mitigations
- Retry loops amplify load: mitigate with small N and jitter.
- Conflicts hide real logic bugs: mitigate by logging a structured warning after the final retry.

## Acceptance Criteria
- Common conflict cases converge without operator intervention.
- Conflict retries are bounded and observable.

## References
- Kubernetes optimistic concurrency control: https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions

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
