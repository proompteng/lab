# Chart envFrom Conflict Resolution

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

