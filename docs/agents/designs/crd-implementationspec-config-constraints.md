# CRD: ImplementationSpec Runtime Config Constraints

Status: Draft (2026-02-07)

## Overview
ImplementationSpec contains runtime configuration that is later executed by controllers/runners. Without constraints, it is easy to create specs that are invalid or unsafe (e.g., missing required fields, invalid enum values, or overly large embedded configs).

This doc defines validation constraints and how to phase them in safely.

## Goals
- Improve CRD validation so invalid ImplementationSpecs fail fast.
- Avoid breaking existing specs via opt-in validation phases.

## Non-Goals
- Building a full policy engine for ImplementationSpecs.

## Current State
- Go types: `services/jangar/api/agents/v1alpha1/types.go` (ImplementationSpec types live in the same API package).
- Generated CRD: `charts/agents/crds/agents.proompteng.ai_implementationspecs.yaml`.
- Controller uses ImplementationSpecs during run submission:
  - `services/jangar/src/server/agents-controller.ts` (resolves ImplementationSpecRef / inline implementation).

## Design
### Validation constraints (examples)
- Enums for runtime type already exist for AgentRun runtime (`workflow|job|temporal|custom`); extend similarly where needed.
- Add size limits:
  - `maxProperties` on config maps
  - `maxLength` on strings that can grow unbounded
- Add CEL rules to enforce mutual exclusivity patterns (like existing systemPrompt vs systemPromptRef).

### Phased enforcement
- Add new validations as warnings first (controller condition) before baking into CRD schema.
- Once confirmed, move into CRD `x-kubernetes-validations` (CEL).

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_IMPLEMENTATIONSPEC_VALIDATE_STRICT` | strictness | If true, invalid specs are marked Ready=False and blocked from execution. |

## Rollout Plan
1. Add controller-side validations + Ready=False conditions.
2. After a canary window, promote the most important constraints into the CRD schema.

Rollback:
- Disable strict validation env var and revert schema change if needed (requires CRD management plan).

## Validation
```bash
kubectl -n agents get implementationspec -o yaml | rg -n \"spec:|x-kubernetes-validations\"
```

## Failure Modes and Mitigations
- Schema changes reject previously accepted objects: mitigate by phased controller-first validation and careful CRD upgrades.
- Overly strict constraints block legitimate use: mitigate by documenting intent and providing escape hatches when safe.

## Acceptance Criteria
- Invalid ImplementationSpecs are rejected or clearly marked not-ready before execution.
- The most common spec errors are caught by CRD validation, not runtime failures.

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
