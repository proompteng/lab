# Controller Finalizer Conventions

Status: Draft (2026-02-06)

## Overview
Finalizers ensure controllers can perform cleanup before an object is fully deleted (e.g., deleting external runtimes). Inconsistent finalizer naming and behavior can cause stuck deletions or skipped cleanup.

This doc defines naming conventions and lifecycle behavior for Agents controllers.

## Goals
- Standardize finalizer naming and behavior.
- Ensure deletion cleanup is best-effort but does not deadlock deletion.

## Non-Goals
- Guaranteeing cleanup success in all cases (network outages, permission failures).

## Current State
- AgentRun uses a runtime cleanup finalizer:
  - `services/jangar/src/server/agents-controller.ts` uses finalizer `agents.proompteng.ai/runtime-cleanup`.
- Cleanup attempts call `cancelRuntime(...)` and then remove the finalizer via patch.
- Other CRDs may not use finalizers consistently.

## Design
### Naming
- Format: `<group>/<purpose>` under the API group domain, e.g.:
  - `agents.proompteng.ai/runtime-cleanup`
  - `orchestration.proompteng.ai/runtime-cleanup` (if needed)

### Behavior
- On deletion timestamp:
  - Attempt cleanup with bounded timeouts.
  - Never re-add finalizers once deletion has started.
  - Always remove the finalizer after cleanup attempt, even on failure (log error).

## Config Mapping
| Proposed env var | Intended behavior |
|---|---|
| `JANGAR_CONTROLLER_FINALIZER_CLEANUP_TIMEOUT_MS` | Upper bound for cleanup steps before removing finalizer anyway. |

## Rollout Plan
1. Document naming conventions and current AgentRun behavior.
2. Add bounded-time cleanup and ensure finalizer removal happens even on failure.
3. Add tests covering deletion paths for AgentRun (and others if applicable).

Rollback:
- Revert cleanup timeout logic; keep naming conventions.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.finalizers}'; echo
kubectl -n agents delete agentrun <name> --wait=false
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.deletionTimestamp}'; echo
```

## Failure Modes and Mitigations
- Finalizer never removed, object stuck deleting: mitigate with bounded cleanup time and “remove anyway” behavior.
- Cleanup fails silently: mitigate with explicit logs/events on cleanup failure.

## Acceptance Criteria
- Deleting an AgentRun does not deadlock due to cleanup failures.
- Finalizer names are consistent and documented.

## References
- Kubernetes finalizers: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/

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
