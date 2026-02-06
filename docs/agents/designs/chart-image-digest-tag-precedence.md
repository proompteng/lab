# Chart Image Digest/Tag Precedence

Status: Draft (2026-02-06)

## Overview
The Agents chart supports image tags and optional digests for both the control plane and controllers. In production GitOps, digests are preferred for immutability. The chart currently concatenates `repo:tag@digest` when a digest is provided, but the operational contract (and failure modes) are not documented.

## Goals
- Define a clear contract for tag + digest usage.
- Prevent accidental drift (e.g. `tag: latest` without digest).
- Provide a safe upgrade/rollback process.

## Non-Goals
- Introducing an image signing/verification system (covered elsewhere).

## Current State
- Values: `charts/agents/values.yaml` under `image.*`, `controlPlane.image.*`, `controllers.image.*`.
- Template image rendering:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- GitOps pins digests in `argocd/applications/agents/values.yaml`.

## Design
### Rendering rules
- If `digest` is non-empty: render `repository:tag@digest`.
- If `digest` is empty: render `repository:tag`.
- Component-specific image blocks override the root `image.*` values for that component.

### Production policy
- Production profiles MUST set `digest` for all images.
- `tag` remains required even when digest is set (for readability), but it is informational-only.

### Chart validation
Add optional enforcement:
- `imagePolicy.requireDigest=true` (default `false`): when enabled, render fails if any enabled component lacks a digest.

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `image.repository` | `spec.template.spec.containers[].image` | Default repository for control plane and (if unset) controllers. |
| `image.tag` | image string | Used when digest is absent; informational when digest is present. |
| `image.digest` | image string | If set, pins an immutable manifest. |
| `controlPlane.image.*` | control plane image string | Overrides root `image.*`. |
| `controllers.image.*` | controllers image string | Overrides root `image.*`. |

## Rollout Plan
1. Add documentation + schema keys (no behavior change).
2. Enable `imagePolicy.requireDigest=true` in non-prod first.
3. Enable in prod after verifying image promotion pipeline always supplies digests.

Rollback:
- Disable `imagePolicy.requireDigest`.
- Roll back values to prior digests; no template changes required.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"image:|@sha256:\"
```

Live:
```bash
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Digest set with wrong tag: safe (digest wins); mitigate confusion by documenting tag informational-only.
- Digest omitted in prod: mitigate via enforcement flag and CI checks on GitOps values.
- Registry garbage-collects unreferenced manifests: mitigate by retaining digests used in GitOps history.

## Acceptance Criteria
- Production values pin digests for all enabled components.
- Optional chart enforcement can be turned on without code changes.

## References
- Kubernetes container image names (tag/digest): https://kubernetes.io/docs/concepts/containers/images/

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
