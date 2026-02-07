# Chart Termination Grace + preStop Hook

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

## Overview
The control plane and controllers handle active requests and ongoing reconciliations. During rollout or node drain, pods should stop accepting new work and drain in-flight tasks before termination. The chart currently does not expose termination grace or preStop hooks.

## Goals
- Add configurable `terminationGracePeriodSeconds`.
- Add optional `preStop` hooks to support graceful shutdown.

## Non-Goals
- Implementing full “drain queues before exit” semantics in the chart alone (requires controller code support).

## Current State
- Templates:
  - `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml` do not set `terminationGracePeriodSeconds` or lifecycle hooks.
- Runtime shutdown behavior is code-defined and may be abrupt if SIGTERM is not handled carefully:
  - Controllers: `services/jangar/src/server/agents-controller.ts` (shutdown path)
  - Control plane: server entrypoints under `services/jangar/src/server/*`

## Design
### Proposed values
Add:
- `terminationGracePeriodSeconds` (global default)
- `controlPlane.terminationGracePeriodSeconds`
- `controllers.terminationGracePeriodSeconds`
- `controlPlane.lifecycle.preStop`
- `controllers.lifecycle.preStop`

### Recommended defaults
- Control plane: 30s
- Controllers: 60s (to finish reconcile loops)

## Config Mapping
| Helm value | Rendered field | Intended behavior |
|---|---|---|
| `controllers.terminationGracePeriodSeconds` | `deploy/agents-controllers.spec.template.spec.terminationGracePeriodSeconds` | Gives controllers time to stop cleanly. |
| `controlPlane.lifecycle.preStop` | `containers[].lifecycle.preStop` | Stop accepting traffic before termination. |

## Rollout Plan
1. Ship values with conservative defaults.
2. Add controller/control plane logs on SIGTERM (“draining”).
3. Tune grace periods based on observed shutdown times.

Rollback:
- Remove lifecycle settings; Kubernetes defaults apply.

## Validation
```bash
helm template agents charts/agents | rg -n \"terminationGracePeriodSeconds|preStop\"
kubectl -n agents rollout restart deploy/agents
kubectl -n agents rollout restart deploy/agents-controllers
```

## Failure Modes and Mitigations
- Grace period too short causes dropped requests or partial reconciliation: mitigate by conservative defaults and observability of shutdown durations.
- Grace period too long slows rollouts: mitigate by tuning and adding early-drain behavior in code.

## Acceptance Criteria
- Pods drain predictably during rollouts and node drains.
- Termination settings are configurable per component.

## References
- Kubernetes container lifecycle hooks: https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/

