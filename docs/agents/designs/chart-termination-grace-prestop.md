# Chart Termination Grace + preStop Hook

Status: Draft (2026-02-06)

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
