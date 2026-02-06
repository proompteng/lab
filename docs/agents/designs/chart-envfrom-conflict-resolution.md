# Chart envFrom Conflict Resolution

Status: Draft (2026-02-06)

## Overview
The Agents chart supports both explicit `env:` entries and bulk import via `envFrom` (Secrets/ConfigMaps). Kubernetes allows both, but precedence can be confusing: explicitly defined `env:` variables take precedence over values from `envFrom`.

This doc defines how the chart should use these mechanisms safely and what operators should expect.

## Goals
- Make `envFrom` behavior predictable for production installs.
- Avoid “silent overrides” of critical configuration.
- Provide guidance for GitOps-managed Secret/ConfigMap injection.

## Non-Goals
- Building a full secret management system (use External Secrets, SOPS, etc.).
- Adding new CRDs for configuration.

## Current State
- Chart templates render `envFrom` if `envFromSecretRefs` or `envFromConfigMapRefs` are non-empty:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- The same templates also render explicit `env:` entries from:
  - `.Values.env.vars` (template-generated list)
  - `.Values.env.secrets`, `.Values.env.config`, `.Values.env.extra`
- Cluster desired state uses `envFromSecretRefs` in `argocd/applications/agents/values.yaml`.

## Design
### Recommended contract
- `envFromSecretRefs` / `envFromConfigMapRefs` are intended for:
  - Provider credentials (non-chart-specific vars).
  - Optional feature toggles that are safe to override.
- Chart-managed “safety” vars MUST always be set via explicit `env:` so they win over `envFrom`.

### Future improvement (chart-level validation)
Add a Helm validation rule (in `charts/agents/templates/validation.yaml`) that:
- Fails the render if `envFrom*` is used to set any reserved keys (a documented denylist), unless an explicit override value is also provided under `.Values.env.vars` or component-local `*.env.vars`.

## Config Mapping
| Helm value | Rendered pod spec | Behavior |
|---|---|---|
| `envFromSecretRefs: [\"agents-github-token-env\"]` | `envFrom.secretRef` | Imports all keys as env vars; may be overridden by explicit `env:`. |
| `envFromConfigMapRefs: [\"agents-flags\"]` | `envFrom.configMapRef` | Imports all keys as env vars; may be overridden by explicit `env:`. |
| `env.extra[{name,value}]` | explicit `env:` | Highest precedence; good for chart-managed defaults. |
| `env.secrets[{name,secretName,key}]` | explicit `env:` via `secretKeyRef` | Highest precedence; used for specific, named secrets. |
| `env.config[{name,configMapName,key}]` | explicit `env:` via `configMapKeyRef` | Highest precedence; used for specific, named config keys. |

## Rollout Plan
1. Document reserved keys + precedence in `charts/agents/README.md`.
2. Add render-time validation (denylist) behind a new value `validation.reservedEnvKeysEnforced` default `false`.
3. Enable enforcement in `values-prod.yaml` after a canary.

Rollback:
- Disable enforcement flag and re-sync Argo CD.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"envFrom:|secretRef:|configMapRef:\"
```

Live:
```bash
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].envFrom}'
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].env}'
```

## Failure Modes and Mitigations
- Secret injects a key that shadows a chart-managed key: mitigate with reserved-key validation + docs.
- Operators expect `envFrom` to override `env:`: mitigate by making precedence explicit in design docs and chart README.
- Large Secrets exceed env var limits: mitigate by using explicit `env.secrets` for the minimal set of keys.

## Acceptance Criteria
- A reserved-key denylist exists and is enforced in production.
- Operators can safely add `envFrom*` without destabilizing chart defaults.

## References
- Kubernetes: define env vars and `envFrom`: https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/

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
