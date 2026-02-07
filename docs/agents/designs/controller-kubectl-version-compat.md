# Controller kubectl Version Compatibility

Status: Draft (2026-02-07)

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
