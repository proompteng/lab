# CRD: ImplementationSource Webhook CEL Invariants

Status: Draft (2026-02-07)

## Overview
ImplementationSource supports webhook-driven ingestion. Certain fields must be present together (e.g., `webhook.enabled` implies a `secretRef`). Today, some of these invariants are enforced in code, but encoding them in CRD CEL rules provides immediate feedback at apply time.

## Goals
- Encode basic webhook invariants as CRD CEL rules.
- Reduce runtime “misconfigured source” errors.

## Non-Goals
- Encoding provider-specific rules that require external calls.

## Current State
- CRD exists: `charts/agents/crds/agents.proompteng.ai_implementationsources.yaml`.
- Webhook runtime logic: `services/jangar/src/server/implementation-source-webhooks.ts`.
- Signature verification expects a secret when webhook enabled (see `selectVerifiedSources(...)`).

## Design
### Proposed CEL validations
- If `spec.webhook.enabled == true` then `spec.webhook.secretRef.name` and `.key` must be non-empty.
- If provider is GitHub, require that `spec.webhook.events` includes the expected event types (optional).

Example CEL:
```yaml
x-kubernetes-validations:
  - rule: '!(has(self.spec.webhook) && self.spec.webhook.enabled) || (has(self.spec.webhook.secretRef) && self.spec.webhook.secretRef.name != "" && self.spec.webhook.secretRef.key != "")'
    message: "webhook.enabled requires webhook.secretRef.{name,key}"
```

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `controller.enabled` / `JANGAR_AGENTS_CONTROLLER_ENABLED` | toggles reconciliation | CEL rules validate at API server on apply, independent of controller runtime. |

## Rollout Plan
1. Add CEL rules in CRD generation (Go markers) and regenerate `charts/agents/crds`.
2. Canary in non-prod by applying misconfigured ImplementationSources and confirming rejection.

Rollback:
- Revert CRD validation rules (requires CRD management plan).

## Validation
```bash
helm template agents charts/agents --include-crds | rg -n \"implementationsources|x-kubernetes-validations\"
kubectl -n agents apply -f charts/agents/examples/implementationsource-github.yaml
```

## Failure Modes and Mitigations
- Validation is too strict for legacy objects: mitigate by introducing rules only when fields exist, and by staging rollouts.
- Cluster API server older than CEL support level: mitigate by checking Kubernetes version and gating rules accordingly.

## Acceptance Criteria
- Misconfigured webhook-enabled ImplementationSources are rejected at apply time.
- Valid sources continue to work without modification.

## References
- Kubernetes CRD validation rules (CEL): https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation-rules

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
