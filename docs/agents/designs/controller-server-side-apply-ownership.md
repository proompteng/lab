# Controller Server-Side Apply and Field Ownership

Status: Draft (2026-02-06)

## Overview
Controllers currently use `kubectl apply` (client-side) for many operations, and `kubectl apply --server-side --subresource=status` for status updates. Server-side apply (SSA) provides clear field ownership and reduces merge conflicts when multiple actors mutate the same objects.

This doc proposes standardizing SSA usage and setting explicit field managers.

## Goals
- Use SSA for status updates consistently (already present).
- Evaluate SSA for spec/apply operations where multiple writers exist.
- Reduce conflicts and improve auditability of field ownership.

## Non-Goals
- Rewriting controllers to use the Kubernetes Go client.

## Current State
- Kubernetes operations are executed via `kubectl`:
  - `services/jangar/src/server/primitives-kube.ts`
- SSA is currently used only for status apply:
  - `applyStatus`: `kubectl apply --server-side --subresource=status ...`
- Regular `apply` uses `kubectl apply -f -` without SSA.

## Design
### SSA policy
- Continue SSA for status with a stable field manager:
  - Add `--field-manager=jangar-controllers` to SSA calls.
- For spec/apply operations:
  - Use SSA only when controllers should own specific fields and conflicts are likely.
  - Otherwise keep client-side apply to reduce surprise conflicts.

### Implementation changes
- Update `applyStatus` in `primitives-kube.ts` to include `--field-manager`.
- Add an alternate `applyServerSide` method (optional) with the same field manager.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_KUBECTL_FIELD_MANAGER` | `JANGAR_KUBECTL_FIELD_MANAGER` | Allows overriding the field manager name (default `jangar-controllers`). |

## Rollout Plan
1. Add field-manager to SSA status apply (low risk).
2. Canary in non-prod and check managedFields in CR status updates.
3. Evaluate SSA for spec apply paths case-by-case.

Rollback:
- Remove the `--field-manager` flag; SSA still works with default manager.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.managedFields[*].manager}'; echo
```

## Failure Modes and Mitigations
- Field ownership conflicts prevent apply: mitigate with targeted SSA usage and explicit field manager.
- ManagedFields growth increases object size: mitigate by avoiding SSA where unnecessary.

## Acceptance Criteria
- Status updates use a stable field manager name.
- Operators can inspect managed fields to understand what controllers own.

## References
- Kubernetes Server-Side Apply: https://kubernetes.io/docs/reference/using-api/server-side-apply/

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
