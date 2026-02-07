# Chart Database URL vs SecretRef Precedence

Status: Draft (2026-02-07)

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

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
