# Postgres TLS: PGSSLROOTCERT Wiring and Validation

Status: Draft (2026-02-06)

## Overview
The chart supports mounting a Postgres CA bundle via `database.caSecret` and sets `PGSSLROOTCERT` to the mounted path. This is essential for production TLS, but it needs a documented contract (secret key naming, mount paths, rotation).

## Goals
- Ensure TLS CA mounting is consistent for both deployments.
- Provide clear rotation and rollback guidance.
- Validate misconfigurations at render time.

## Non-Goals
- Managing Postgres certificates themselves (CNPG/cert-manager concerns).

## Current State
- Values: `charts/agents/values.yaml` → `database.caSecret.name`, `database.caSecret.key`.
- Templates:
  - Mount secret to `/etc/jangar/ca` and set `PGSSLROOTCERT`: `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml`.
  - Secret volume name is `db-ca-cert` (reserved).
- Runtime relies on libpq behavior; TLS settings are implied by `DATABASE_URL` parameters + `PGSSLROOTCERT`.

## Design
### Contract
- If `database.caSecret.name` is set:
  - Chart MUST mount the Secret as a read-only volume.
  - Chart MUST set `PGSSLROOTCERT` to `/etc/jangar/ca/<key>`.
- The Secret MUST contain the key specified by `database.caSecret.key` (default `ca.crt`).

### Validation
- Render-time validation should fail if:
  - `database.caSecret.name` is set but `database.caSecret.key` is empty.

## Config Mapping
| Helm value | Rendered field/env | Intended behavior |
|---|---|---|
| `database.caSecret.name` | Secret volume + mount | Enables CA bundle injection. |
| `database.caSecret.key` | `PGSSLROOTCERT=/etc/jangar/ca/<key>` | Points libpq to the CA cert file. |

## Rollout Plan
1. Add documentation for required Secret contents and examples.
2. Canary-enable CA secret in non-prod, verify DB connects with TLS.
3. Rotate CA by updating Secret; if using checksum rollouts, pods restart automatically.

Rollback:
- Remove `database.caSecret.*` values and revert Secret to prior version.

## Validation
```bash
helm template agents charts/agents --set database.caSecret.name=my-ca --set database.caSecret.key=ca.crt | rg -n \"PGSSLROOTCERT|db-ca-cert\"
kubectl -n agents get deploy agents -o yaml | rg -n \"PGSSLROOTCERT|db-ca-cert\"
```

## Failure Modes and Mitigations
- Wrong key name causes connection failures: mitigate with validation and clear error logs.
- CA rotation requires pod restart: mitigate with checksum-triggered rollouts.

## Acceptance Criteria
- Both deployments mount the CA secret identically when enabled.
- Render-time validation prevents empty key configurations.

## References
- Kubernetes Secrets volumes: https://kubernetes.io/docs/concepts/storage/volumes/#secret


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
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
