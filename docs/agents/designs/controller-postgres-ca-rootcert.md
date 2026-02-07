# Postgres TLS: PGSSLROOTCERT Wiring and Validation

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

