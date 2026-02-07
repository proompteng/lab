# Postgres TLS: PGSSLROOTCERT Wiring and Validation

Status: Draft (2026-02-07)
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

See `docs/agents/designs/handoff-common.md`.
