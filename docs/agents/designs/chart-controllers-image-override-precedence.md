# Chart Controllers Image Override Precedence

Status: Draft (2026-02-06)

## Overview
The Agents chart can run controllers as a separate Deployment (`agents-controllers`) with its own image. Operators need a clear contract for how `controllers.image.*` relates to the root `image.*` and the control plane `controlPlane.image.*`.

## Goals
- Define image selection precedence for `agents-controllers`.
- Enable safe canarying controllers independently from the control plane.

## Non-Goals
- Supporting multiple controller images in a single release (one deployment only).

## Current State
- Controllers deployment template: `charts/agents/templates/deployment-controllers.yaml` computes:
  - `$imageRepo := .Values.controllers.image.repository | default .Values.image.repository`
  - similarly for `tag`, `digest`, `pullPolicy`, `pullSecrets`
- Values surface: `charts/agents/values.yaml` under `controllers.image.*` and `image.*`.
- GitOps currently pins both control plane and controller images in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for controllers
1. `controllers.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Operational policy
- For production: always set `controllers.image.digest` explicitly when `controllers.enabled=true`.
- For canary: bump controllers digest first, validate, then bump control plane digest.

## Config Mapping
| Helm value | Rendered image for `agents-controllers` | Notes |
|---|---|---|
| `controllers.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controllers.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controllers.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controllers.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Add this contract to `charts/agents/README.md`.
2. Add a CI check that `controllers.enabled=true` implies `controllers.image.digest` is non-empty in prod overlays.
3. Use an Argo CD canary window (manual sync or progressive wave) before promoting.

Rollback:
- Revert `controllers.image.digest` to the prior known-good digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"name: agents-controllers|image:\"
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Controllers image accidentally inherits `image.tag=latest` without digest: mitigate via validation/enforcement in prod.
- Canary controllers uses incompatible schema vs CRDs: mitigate by bundling CRD changes + controllers changes in one PR when APIs change.

## Acceptance Criteria
- Operators can canary `agents-controllers` without modifying the control plane deployment.
- A prod overlay policy ensures controllers run by digest, not mutable tags.

## References
- Kubernetes container images: https://kubernetes.io/docs/concepts/containers/images/

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
