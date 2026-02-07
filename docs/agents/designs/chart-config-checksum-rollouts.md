# Chart Config Checksum Rollouts

Status: Draft (2026-02-07)

## Overview
Kubernetes does not automatically restart pods when referenced Secrets/ConfigMaps change (especially when referenced via env vars). In GitOps environments, this frequently leads to “updated Secret, pods still using old value” incidents.

This doc proposes checksum annotations to trigger Deployment rollouts when selected config inputs change.

## Goals
- Provide an opt-in mechanism to restart control plane/controllers when key Secrets/ConfigMaps change.
- Make the behavior explicit and easy to validate in Helm renders.

## Non-Goals
- Automatically restarting on all Secrets/ConfigMaps in the namespace.

## Current State
- Chart references:
  - DB URL Secret: `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml`
  - `envFromSecretRefs` / `envFromConfigMapRefs`: same templates
- No checksum annotations exist in pod templates.

## Design
### Proposed values
Add:
- `rolloutChecksums.enabled` (default `false`)
- `rolloutChecksums.secrets: []`
- `rolloutChecksums.configMaps: []`

When enabled, annotate pod templates with:
- `checksum/secret/<name>: <sha256>`
- `checksum/configmap/<name>: <sha256>`

### Implementation detail
- Hash the rendered Secret/ConfigMap data when defined in-chart, and the name only (or `lookup`) when managed externally.
  - In GitOps, `lookup` behavior varies; prefer explicit operator-provided checksums when needed.

## Config Mapping
| Helm value | Rendered annotation | Intended behavior |
|---|---|---|
| `rolloutChecksums.enabled=true` | `checksum/*` annotations | Any change triggers a Deployment rollout. |
| `rolloutChecksums.secrets=[\"agents-github-token-env\"]` | `checksum/secret/agents-github-token-env` | Restart when the referenced Secret changes. |

## Rollout Plan
1. Add feature behind `rolloutChecksums.enabled=false`.
2. Enable in non-prod with one Secret (e.g. GitHub token) to validate.
3. Enable in prod after validating rollout behavior and avoiding excessive restarts.

Rollback:
- Disable the flag; annotation removal stops checksum-triggered rollouts.

## Validation
```bash
helm template agents charts/agents | rg -n \"checksum/\"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

## Failure Modes and Mitigations
- Too many checksum sources cause frequent rollouts: mitigate with explicit allowlist and opt-in.
- Checksum cannot be computed for external Secrets: mitigate by allowing user-provided checksum values.

## Acceptance Criteria
- Enabling the feature causes a deterministic rollout on config changes.
- Operators can scope restarts to a small list of critical Secrets/ConfigMaps.

## References
- Kubernetes ConfigMaps/Secrets update behavior: https://kubernetes.io/docs/concepts/configuration/configmap/

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
