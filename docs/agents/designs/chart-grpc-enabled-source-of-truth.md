# Chart gRPC Enabled: Single Source of Truth

Status: Draft (2026-02-06)

## Overview
The chart has `grpc.enabled` (controls Service + container port) while runtime can also be toggled with `JANGAR_GRPC_ENABLED` (via `env.vars`). When these disagree, the deployment can become confusing: a Service may exist without the server listening, or the server may listen without a Service/port.

This doc defines a single-source-of-truth contract.

## Goals
- Ensure `grpc.enabled` and `JANGAR_GRPC_ENABLED` cannot drift.
- Provide a safe migration path for existing installs.

## Non-Goals
- Changing the gRPC API surface area.

## Current State
- Chart:
  - Service template: `charts/agents/templates/service-grpc.yaml` gated on `grpc.enabled`.
  - Container port for gRPC is gated on `grpc.enabled`: `charts/agents/templates/deployment.yaml`.
  - Controllers deployment defaults `JANGAR_GRPC_ENABLED=0`: `charts/agents/templates/deployment-controllers.yaml`.
- GitOps:
  - `argocd/applications/agents/values.yaml` sets `grpc.enabled: true` and also sets `JANGAR_GRPC_ENABLED: \"true\"` under `env.vars`.

## Design
### Contract
- `grpc.enabled` MUST be the only control-plane switch.
- The chart MUST render `JANGAR_GRPC_ENABLED` for the control plane based on `grpc.enabled` (and ignore user-provided overrides unless explicitly allowed).
- Controllers deployment MUST continue to default-disable gRPC unless there is a concrete use-case.

### Migration
- Introduce `grpc.manageEnvVar` (default `true`):
  - When `true`, template sets `JANGAR_GRPC_ENABLED` from `grpc.enabled`.
  - When `false`, chart does not set it and operators can manage it manually.

## Config Mapping
| Helm value | Rendered env var / object | Intended behavior |
|---|---|---|
| `grpc.enabled=true` | `Service/agents-grpc` + `containerPort: grpc` + `JANGAR_GRPC_ENABLED=1` | Server listens and is reachable via Service. |
| `grpc.enabled=false` | no gRPC Service/port + `JANGAR_GRPC_ENABLED=0` | Server does not expose/listen. |

## Rollout Plan
1. Add `grpc.manageEnvVar` default `true`, but accept existing `env.vars.JANGAR_GRPC_ENABLED` with a warning (no failure).
2. Update GitOps values to remove redundant `JANGAR_GRPC_ENABLED`.
3. After a canary, enforce: render fails if `grpc.manageEnvVar=true` and user sets `JANGAR_GRPC_ENABLED`.

Rollback:
- Set `grpc.manageEnvVar=false` and restore explicit env var management.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"agents-grpc|containerPort: grpc|JANGAR_GRPC_ENABLED\"
kubectl -n agents get svc agents-grpc
kubectl -n agents get endpointslice -l app.kubernetes.io/name=agents
```

## Failure Modes and Mitigations
- gRPC Service exists but server not listening: mitigate by having chart manage the env var.
- Server listens but no Service/port: mitigate by coupling the env var to `grpc.enabled`.

## Acceptance Criteria
- `grpc.enabled` reliably predicts whether gRPC is reachable.
- GitOps values do not need to set `JANGAR_GRPC_ENABLED` manually for the control plane.

## References
- Kubernetes Services: https://kubernetes.io/docs/concepts/services-networking/service/

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart behavior: `charts/agents/values.yaml`, `charts/agents/values.schema.json`, `charts/agents/templates/`
- Chart render-time validation: `charts/agents/templates/validation.yaml`
- GitOps desired state:
  - `agents` app (CRDs + controllers + service): `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
  - `jangar` app (product deployment + primitives): `argocd/applications/jangar/kustomization.yaml`
  - Product enablement: `argocd/applicationsets/product.yaml`

### Values → env var mapping (chart)
- Control plane env var merge + rendering: `charts/agents/templates/deployment.yaml`
- Controllers env var merge + rendering: `charts/agents/templates/deployment-controllers.yaml`
- Common pattern: `.Values.env.vars` are merged with component-specific vars (control plane: `.Values.controlPlane.env.vars`, controllers: `.Values.controllers.env.vars`). Component-specific keys win.

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

### Rollout plan (GitOps)
1. Change chart templates/values/schema in `charts/agents/**`.
2. If the chart `version:` changes, keep `charts/agents/Chart.yaml` and `argocd/applications/agents/kustomization.yaml` in sync.
3. Validate rendering locally (no cluster access required):

```bash
mise exec helm@3.15.4 -- helm lint charts/agents
mise exec helm@3.15.4 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml --include-crds > /tmp/agents.helm.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
scripts/agents/validate-agents.sh
```

4. Merge to `main`; Argo CD reconciles.

### Validation (post-merge)
- Confirm Argo sync + workloads healthy:

```bash
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl logs -n agents deploy/agents-controllers --tail=200
```
