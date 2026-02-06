# CRD: AgentRun Spec Immutability Rules

Status: Draft (2026-02-06)

## Overview
AgentRuns represent a concrete execution request. After a run is accepted and started, mutating most of `spec` should be prohibited to preserve auditability and avoid undefined behavior (e.g., swapping implementation mid-run).

This doc defines which fields are mutable vs immutable and how controllers should enforce that.

## Goals
- Prevent unsafe spec mutations after acceptance/start.
- Provide clear, actionable errors for attempted mutations.

## Non-Goals
- Adding a full admission webhook; controller-side enforcement is sufficient initially.

## Current State
- AgentRun schema: `services/jangar/api/agents/v1alpha1/types.go` and `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`.
- Controller reconciles AgentRuns and transitions phases/conditions:
  - `services/jangar/src/server/agents-controller.ts` (reconcileAgentRun, runtime submission, status updates).
- No explicit immutability enforcement is documented.

## Design
### Immutable after `Accepted=True` or `status.phase != Pending`
- `spec.agentRef`
- `spec.implementationSpecRef` / `spec.implementation`
- `spec.runtime` (type/config)
- `spec.workflow` steps (if present)
- `spec.secrets`
- `spec.systemPrompt` / `spec.systemPromptRef`
- `spec.vcsRef`, `spec.memoryRef`

### Mutable always (safe metadata-only)
- `metadata.labels` and annotations (except controller-owned labels)

### Enforcement
- Controller records a hash of the immutable spec fields in status at accept time, e.g.:
  - `status.specHash`
- On subsequent reconciles, if immutable fields differ:
  - Set `Succeeded=False`/`Ready=False` (resource-specific) and `phase=Failed` with reason `SpecImmutableViolation`.
  - Emit a Kubernetes Event (see controller events design).

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED` | toggle | Allows phased rollout (default `true` in prod). |

## Rollout Plan
1. Implement in warn-only mode (log + condition) in non-prod.
2. Promote to fail/terminal failure in prod.

Rollback:
- Set `JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED=false` to revert to warn-only.

## Validation
```bash
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents patch agentrun <name> --type=merge -p '{\"spec\":{\"parameters\":{\"x\":\"y\"}}}'
kubectl -n agents get agentrun <name> -o yaml | rg -n \"SpecImmutableViolation|specHash|conditions\"
```

## Failure Modes and Mitigations
- Users rely on mutating pending runs: mitigate by allowing mutation only before acceptance and documenting clearly.
- Controller mis-identifies a harmless change: mitigate with a clearly defined immutable field set and tests.

## Acceptance Criteria
- Once accepted/started, spec mutations are rejected with a clear condition/reason.
- Before acceptance, allowed fields can still be updated safely.

## References
- Kubernetes immutability patterns (general objects): https://kubernetes.io/docs/concepts/overview/working-with-objects/kubernetes-objects/


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
