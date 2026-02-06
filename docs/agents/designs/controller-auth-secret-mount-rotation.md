# Controller Auth Secret Mount and Rotation

Status: Draft (2026-02-06)

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
