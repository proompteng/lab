# Controllers Deployment: gRPC Disabled by Default

Status: Draft (2026-02-06)

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
