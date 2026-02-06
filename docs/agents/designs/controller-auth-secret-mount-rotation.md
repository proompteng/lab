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
- Controller implementation: `services/jangar/src/server/agents-controller.ts`
- Supporting controllers:
  - Orchestration: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks: `services/jangar/src/server/primitives-policy.ts`
- Chart env var wiring (controllers deployment): `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state: `argocd/applications/agents/values.yaml` (inputs to chart)

### Values → env var mapping (controllers)
- `controller.*` values in `charts/agents/values.yaml` map to `JANGAR_AGENTS_CONTROLLER_*` env vars in `charts/agents/templates/deployment-controllers.yaml`.
- The controller reads env via helpers like `parseEnvStringList`, `parseEnvRecord`, `parseJsonEnv` in `services/jangar/src/server/agents-controller.ts`.

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

### Rollout plan
1. Update controller code under `services/jangar/src/server/`.
2. Build/push image(s) (out of scope in this doc set); then update GitOps pins:
   - `argocd/applications/agents/values.yaml` (controllers/control plane images)
   - `argocd/applications/jangar/kustomization.yaml` (product `jangar` image)
3. Merge to `main`; Argo CD reconciles.

### Validation
- Unit tests (fast): `bun run --filter jangar test`
- Render desired manifests (no cluster needed):

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
```

- Live cluster (requires kubeconfig): see commands in “Current cluster state” above.
