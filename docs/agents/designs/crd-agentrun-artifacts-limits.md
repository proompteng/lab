# CRD: AgentRun Artifacts Limits and Schema

Status: Draft (2026-02-06)

## Overview
AgentRun status can accumulate artifacts, logs, and metadata. Without limits and schema conventions, status can grow large, exceed Kubernetes object size limits, and create performance issues for controllers and clients.

This doc defines size and count limits plus a recommended artifact schema.

## Goals
- Bound AgentRun status size.
- Keep artifact references lightweight (store large content externally).
- Provide predictable retrieval patterns for operators.

## Non-Goals
- Designing the external artifact store (handled elsewhere).

## Current State
- AgentRun status includes `artifacts []Artifact` in Go types:
  - `services/jangar/api/agents/v1alpha1/types.go`
- Controller writes artifacts into status during run reconciliation:
  - `services/jangar/src/server/agents-controller.ts`
- CRD schema is generated in `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`.

## Design
### Limits (recommended)
- `status.artifacts`:
  - Max entries: 50
  - Max per-entry URL length: 2048
  - No inline binary data
- Enforce limits by:
  - Dropping oldest artifacts beyond limit, or
  - Storing only pointers (S3 URL, object key) in status.

### Schema conventions
Each artifact entry should include:
- `type` (e.g. `log`, `diff`, `report`)
- `uri` (external location)
- `contentType`
- `sizeBytes` (optional)

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_ARTIFACTS_MAX` | bound | Caps artifact list length in status. |
| `controllers.env.vars.JANGAR_AGENTRUN_ARTIFACTS_STRICT` | strictness | If true, fail run when artifacts exceed limits (default false). |

## Rollout Plan
1. Implement soft caps (drop oldest) and emit a warning condition.
2. Add optional strict mode for CI environments.

Rollback:
- Disable caps by setting max high (not recommended) or reverting code.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.status.artifacts}' | wc -c
kubectl -n agents get agentrun <name> -o yaml | rg -n \"artifacts:\"
```

## Failure Modes and Mitigations
- Status exceeds object size limits: mitigate by pointer-only artifacts and strict caps.
- Operators lose needed history due to trimming: mitigate by ensuring external store retains full artifact history.

## Acceptance Criteria
- AgentRun status stays under safe size limits under sustained use.
- Artifacts in status are always external references, not large inline payloads.

## References
- Kubernetes object size limits (etcd considerations): https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/


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
