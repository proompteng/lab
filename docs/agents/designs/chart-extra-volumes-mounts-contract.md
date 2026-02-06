# Chart Extra Volumes/Mounts Contract

Status: Draft (2026-02-06)

## Overview
The chart supports `.Values.extraVolumes` and `.Values.extraVolumeMounts`, which are injected into both the control plane and controllers pod specs. This is a powerful escape hatch but needs a documented contract to prevent accidental conflicts with chart-managed volumes (e.g. DB CA cert).

## Goals
- Define the intended use cases and constraints for extra volumes/mounts.
- Prevent collisions with reserved volume names.
- Make behavior consistent across control plane and controllers.

## Non-Goals
- Building a plugin system; extra volumes remain a low-level escape hatch.

## Current State
- Values: `charts/agents/values.yaml` exposes `extraVolumes` and `extraVolumeMounts`.
- Templates:
  - Control plane mounts/volumes: `charts/agents/templates/deployment.yaml`
  - Controllers mounts/volumes: `charts/agents/templates/deployment-controllers.yaml`
- Chart-managed volume today:
  - `db-ca-cert` when `database.caSecret.name` is set (both deployments).

## Design
### Contract
- Extra volume/mount entries MUST NOT use reserved names:
  - `db-ca-cert` (and any future chart-managed names)
- Extra volumes are applied to both deployments (current behavior). If operators need per-component volumes, add:
  - `controlPlane.extraVolumes`, `controlPlane.extraVolumeMounts`
  - `controllers.extraVolumes`, `controllers.extraVolumeMounts`

### Validation
- Add validation in `charts/agents/templates/validation.yaml`:
  - Fail render if a reserved name is used.
  - Fail render if a mount references a volume name that does not exist (best-effort check).

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `extraVolumes[].name` + `extraVolumes[].volume` | `spec.template.spec.volumes[]` | Appends volumes to both pod specs. |
| `extraVolumeMounts[].name` + `mountPath` | `containers[].volumeMounts[]` | Appends mounts to both containers. |
| `database.caSecret.*` | `db-ca-cert` secret volume + mount | Chart-managed reserved name. |

## Rollout Plan
1. Document reserved names and recommended usage in `charts/agents/README.md`.
2. Add validation (warn-only first if Helm supports; otherwise gated by a values flag).
3. Introduce per-component extras if required by production use-cases.

Rollback:
- Disable validation and/or remove per-component keys; existing global keys remain.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"volumes:|volumeMounts:|db-ca-cert\"
kubectl -n agents get deploy agents -o yaml | rg -n \"extra|db-ca-cert|volumes:|volumeMounts:\"
```

## Failure Modes and Mitigations
- Collision with `db-ca-cert` breaks DB TLS: mitigate with reserved-name validation.
- Mount references missing volume: mitigate with render-time validation.
- Extra volumes unintentionally affect both deployments: mitigate by adding component-scoped keys.

## Acceptance Criteria
- Chart fails render on reserved-name collisions.
- Operators have a documented path for adding CA bundles, SSH known_hosts, or custom credentials.

## References
- Kubernetes volumes: https://kubernetes.io/docs/concepts/storage/volumes/

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
