# Controller Auth Secret Mount and Rotation

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
The controllers deployment supports an “auth secret” for agentctl gRPC authentication via `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_*`. The chart can mount the Secret and set env vars, but the operational contract for rotation is not documented.

## Goals
- Document the auth secret format, mount path, and rotation behavior.
- Ensure safe defaults (auth disabled unless explicitly configured).

## Non-Goals
- Replacing auth with a full identity provider (OIDC, mTLS).

## Current State
- Chart values: `charts/agents/values.yaml` → `controller.authSecret.{name,key,mountPath}`.
- Template wiring (controllers):
  - `charts/agents/templates/deployment-controllers.yaml` sets:
    - `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME`
    - `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY`
    - `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH`
  - It also mounts the secret volume (see the same template for volume/volumeMounts).
- Runtime resolves config and path in `services/jangar/src/server/agents-controller.ts`:
  - `resolveAuthSecretConfig()`, `buildAuthSecretPath()`.
- Tests cover the env var behavior: `services/jangar/src/server/__tests__/agents-controller.test.ts`.

## Design
### Contract
- If `controller.authSecret.name` is empty:
  - Auth is disabled (no secret read).
- If set:
  - Secret MUST contain `key` (default `auth.json`).
  - Secret is mounted read-only at `mountPath` (default `/root/.codex`).
- Rotation:
  - Update the Secret data, then trigger a rollout (checksum annotation or manual restart) so controllers reload.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.authSecret.name` | `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME` | Enables auth secret loading when non-empty. |
| `controller.authSecret.key` | `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY` | Secret data key to read. |
| `controller.authSecret.mountPath` | `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH` | Directory path for mounted secret file. |

## Rollout Plan
1. Document the secret schema and rotation steps.
2. Add checksum rollouts for the auth Secret (opt-in).
3. Add controller startup log: “auth secret enabled/disabled” (without printing secret contents).

Rollback:
- Clear `controller.authSecret.name` and re-sync; controller runs unauthenticated (ensure network access controls).

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"AUTH_SECRET\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"AUTH_SECRET\"
```

## Failure Modes and Mitigations
- Secret is missing or key mismatch: mitigate with render-time validation and clear startup errors.
- Rotation happens but pod does not restart: mitigate with checksum-triggered rollouts.

## Acceptance Criteria
- Auth secret enablement is explicit and observable.
- Rotation steps are documented and testable.

## References
- Kubernetes Secrets: https://kubernetes.io/docs/concepts/configuration/secret/

