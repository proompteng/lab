# Controller kubectl Version Compatibility

Status: Draft (2026-02-06)

## Overview
Controllers interact with the Kubernetes API by spawning the `kubectl` binary (`primitives-kube.ts` and `kube-watch.ts`). This implicitly makes controller correctness dependent on the `kubectl` version baked into the image. We should document and enforce a compatibility policy.

## Goals
- Define a supported `kubectl` version skew policy for controller images.
- Make it easy to verify which `kubectl` version is running.

## Non-Goals
- Migrating controllers to a full Kubernetes client SDK in this phase.

## Current State
- `kubectl` is invoked directly:
  - `services/jangar/src/server/primitives-kube.ts` calls `spawn('kubectl', ...)`
  - `services/jangar/src/server/kube-watch.ts` calls `spawn('kubectl', ['get', ..., '--watch', ...])`
- Helm chart does not surface or validate the kubectl version.
- Cluster Kubernetes version is not tracked in this repo; GitOps manifests do not pin it.

## Design
### Compatibility policy
- Controller image must include `kubectl` within a supported skew of the cluster (documented per Kubernetes guidance).
- Operationally: bake `kubectl` version into the image build and expose it via:
  - `JANGAR_KUBECTL_VERSION` env var (build-time)
  - or a startup log line running `kubectl version --client --short`

### Chart changes (optional)
- Add `controllers.env.vars.JANGAR_KUBECTL_VERSION` passthrough (documented).

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_KUBECTL_VERSION` | `JANGAR_KUBECTL_VERSION` | Exposes build-time kubectl version for debugging. |

## Rollout Plan
1. Add runtime logging of `kubectl version --client`.
2. Add CI check that controller image build pins a known kubectl version (build pipeline work).

Rollback:
- Disable the logging; keep pinned version in images.

## Validation
```bash
kubectl -n agents exec deploy/agents-controllers -- kubectl version --client --short
kubectl -n agents logs deploy/agents-controllers | rg -n \"kubectl\"
```

## Failure Modes and Mitigations
- kubectl/client-server incompatibility causes subtle failures: mitigate with a documented skew policy and proactive logging.
- Missing kubectl binary in image: mitigate by adding a startup self-check that fails fast with a clear error.

## Acceptance Criteria
- Operators can determine the kubectl client version from logs or exec.
- Controller images follow an explicit kubectl skew policy.

## References
- Kubernetes version skew policy: https://kubernetes.io/releases/version-skew-policy/

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
