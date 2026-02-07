# Chart Extra Volumes/Mounts Contract

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
The chart supports `.Values.extraVolumes` and `.Values.extraVolumeMounts`, which are injected into both the control plane and controllers pod specs. This is a powerful escape hatch but needs a documented contract to prevent accidental conflicts with chart-managed volumes (e.g. DB CA cert).

## Goals
- Define the intended use cases and constraints for extra volumes/mounts.
- Prevent collisions with reserved volume names.
- Make behavior consistent across control plane and controllers.

## Non-Goals
- Building a plugin system; extra volumes remain a low-level escape hatch.

## Current State
- Values: `charts/agents/values.yaml` exposes `extraVolumes` and `extraVolumeMounts`.
- Templates:
  - Control plane mounts/volumes: `charts/agents/templates/deployment.yaml`
  - Controllers mounts/volumes: `charts/agents/templates/deployment-controllers.yaml`
- Chart-managed volume today:
  - `db-ca-cert` when `database.caSecret.name` is set (both deployments).

## Design
### Contract
- Extra volume/mount entries MUST NOT use reserved names:
  - `db-ca-cert` (and any future chart-managed names)
- Extra volumes are applied to both deployments (current behavior). If operators need per-component volumes, add:
  - `controlPlane.extraVolumes`, `controlPlane.extraVolumeMounts`
  - `controllers.extraVolumes`, `controllers.extraVolumeMounts`

### Validation
- Add validation in `charts/agents/templates/validation.yaml`:
  - Fail render if a reserved name is used.
  - Fail render if a mount references a volume name that does not exist (best-effort check).

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `extraVolumes[].name` + `extraVolumes[].volume` | `spec.template.spec.volumes[]` | Appends volumes to both pod specs. |
| `extraVolumeMounts[].name` + `mountPath` | `containers[].volumeMounts[]` | Appends mounts to both containers. |
| `database.caSecret.*` | `db-ca-cert` secret volume + mount | Chart-managed reserved name. |

## Rollout Plan
1. Document reserved names and recommended usage in `charts/agents/README.md`.
2. Add validation (warn-only first if Helm supports; otherwise gated by a values flag).
3. Introduce per-component extras if required by production use-cases.

Rollback:
- Disable validation and/or remove per-component keys; existing global keys remain.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"volumes:|volumeMounts:|db-ca-cert\"
kubectl -n agents get deploy agents -o yaml | rg -n \"extra|db-ca-cert|volumes:|volumeMounts:\"
```

## Failure Modes and Mitigations
- Collision with `db-ca-cert` breaks DB TLS: mitigate with reserved-name validation.
- Mount references missing volume: mitigate with render-time validation.
- Extra volumes unintentionally affect both deployments: mitigate by adding component-scoped keys.

## Acceptance Criteria
- Chart fails render on reserved-name collisions.
- Operators have a documented path for adding CA bundles, SSH known_hosts, or custom credentials.

## References
- Kubernetes volumes: https://kubernetes.io/docs/concepts/storage/volumes/

