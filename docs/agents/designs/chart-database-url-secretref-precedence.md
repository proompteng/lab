# Chart Database URL vs SecretRef Precedence

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
3. Add `templates/validation.yaml` rules for production profiles (render-time failure).

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

