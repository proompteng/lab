# Chart Database URL vs SecretRef Precedence

Status: Draft (2026-02-06)

## Overview
The Agents chart supports multiple ways to provide `DATABASE_URL` to both the control plane and controllers. The precedence is currently implicit in templates; misconfiguration can lead to pods starting without a database connection or using an unintended database.

This doc formalizes the precedence rules and recommended operational patterns.

## Goals
- Make the `DATABASE_URL` source deterministic and auditable.
- Support GitOps-friendly database secret management.
- Provide clear failure behavior when database config is missing.

## Non-Goals
- Managing the database lifecycle itself (CNPG, RDS, etc.).
- Automatic database provisioning.

## Current State
- Chart values: `charts/agents/values.yaml` under `database.*`.
- Template renders `DATABASE_URL`:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- Secret creation path: `charts/agents/templates/database-secret.yaml`.
- Cluster desired state: `argocd/applications/agents/values.yaml` uses `database.secretRef`.

## Design
### Precedence (highest wins)
1. `database.url` (inline literal in Helm values; not recommended for prod)
2. `database.secretRef` (preferred; Secret managed outside chart)
3. `database.createSecret.enabled` (chart creates Secret from `database.url`-like values; for dev only)
4. Otherwise: omit `DATABASE_URL` and fail fast (application should refuse to start)

### Required behavior
- Chart SHOULD fail render if none of the above sources are configured for a production profile (e.g. `values-prod.yaml`).
- Runtime SHOULD log a single line at startup indicating which source was used (inline vs Secret).

## Config Mapping
| Helm value | Rendered env var | Intended behavior |
|---|---|---|
| `database.url` | `DATABASE_URL` (literal) | Highest precedence; discouraged for prod GitOps. |
| `database.secretRef.name` + `database.secretRef.key` | `DATABASE_URL` from `secretKeyRef` | Preferred production path. |
| `database.createSecret.enabled=true` | `DATABASE_URL` from chart-created Secret | Dev/local convenience; avoid for prod. |

## Rollout Plan
1. Add docs + README clarifying precedence.
2. Add `values.schema.json` constraints: if `database.createSecret.enabled=true`, require `database.url`.
3. Add `charts/agents/templates/validation.yaml` rules for production profiles (render-time failure).

Rollback:
- Disable validation rules; do not change existing Secret references.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"DATABASE_URL\"
```

Live:
```bash
kubectl -n agents get deploy agents -o yaml | rg -n \"DATABASE_URL\"
kubectl -n agents get secret jangar-db-app -o yaml
```

## Failure Modes and Mitigations
- Both `database.url` and `database.secretRef` set: mitigate by documenting precedence and adding validation warnings.
- Secret exists but key is wrong: mitigate by schema defaults (`key: url`) + startup error with clear message.
- Missing database config causes CrashLoopBackOff: mitigate via render-time validation in prod profiles.

## Acceptance Criteria
- Operators can identify the effective `DATABASE_URL` source from Helm render output.
- Production installs fail fast if database config is missing.

## References
- Kubernetes Secrets as env vars: https://kubernetes.io/docs/concepts/configuration/secret/
- Helm values best practices: https://helm.sh/docs/chart_best_practices/values/

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
