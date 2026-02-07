# Controllers Deployment: gRPC Disabled by Default

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
The chart renders a separate controllers deployment that forces `JANGAR_GRPC_ENABLED=0` unless explicitly overridden. This is a good safety default (controllers do not need to expose gRPC externally), but it is undocumented and can be surprising when operators expect agentctl gRPC to be available everywhere.

This doc defines the intended behavior and introduces a controlled enablement path if needed.

## Goals
- Document why gRPC is disabled in controllers.
- Provide a safe opt-in for controller gRPC only when required.

## Non-Goals
- Making controllers gRPC publicly accessible.

## Current State
- Chart forces defaults in `charts/agents/templates/deployment-controllers.yaml`:
  - Sets `JANGAR_GRPC_ENABLED` to `"0"` unless present in `controllers.env.vars`.
- Control plane gRPC behavior is implemented in:
  - `services/jangar/src/server/control-plane-grpc.ts`
  - `services/jangar/src/server/agentctl-grpc.ts`
- Cluster desired state sets gRPC enabled for control plane in `argocd/applications/agents/values.yaml`.

## Design
### Contract
- Controllers gRPC remains disabled by default.
- If controller gRPC is needed (e.g., for internal debugging), enable it explicitly with:
  - `controllers.env.vars.JANGAR_GRPC_ENABLED: "true"`
and require `controllers.service.enabled=true` (see chart design) to avoid “listening but unreachable” states.

### Additional guardrails
- Add a startup log line in controllers indicating whether gRPC server started.
- Add chart validation: if `controllers.env.vars.JANGAR_GRPC_ENABLED=true`, require `controllers.service.enabled=true`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_GRPC_ENABLED` | `JANGAR_GRPC_ENABLED` | Explicit opt-in for controllers gRPC server. |
| (unset) | `JANGAR_GRPC_ENABLED=0` | Default: controllers do not start gRPC server. |

## Rollout Plan
1. Document current forced default.
2. Add guardrails and optional Service support.
3. If needed, canary-enable controller gRPC in non-prod only.

Rollback:
- Remove the explicit env var and disable controller Service.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_GRPC_ENABLED\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"gRPC|Agentctl\"
```

## Failure Modes and Mitigations
- Operators think gRPC is enabled due to `grpc.enabled=true`: mitigate by documenting that it affects only the control plane.
- gRPC enabled without Service: mitigate with render-time validation and an opt-in Service template.

## Acceptance Criteria
- It is clear (from values + render) whether controllers will run gRPC.
- Enabling controller gRPC requires explicit opt-in and is not accidental.

## References
- gRPC basics: https://grpc.io/docs/what-is-grpc/introduction/

