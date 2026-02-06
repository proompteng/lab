# Controller Condition Type Taxonomy

Status: Draft (2026-02-06)

## Overview
Agents CRDs expose Kubernetes-style conditions (e.g. `Ready`, `Succeeded`, `Blocked`). Without a consistent taxonomy, automation and operator expectations diverge between resources.

This doc defines a minimal, consistent condition set and naming conventions.

## Goals
- Standardize condition types and meanings across Agents CRDs.
- Ensure conditions are stable, machine-consumable signals (not free-form logs).

## Non-Goals
- Defining every possible controller-specific reason code.

## Current State
- CRD types use `[]metav1.Condition`:
  - `services/jangar/api/agents/v1alpha1/types.go`
- Controllers construct and upsert conditions:
  - `services/jangar/src/server/agents-controller.ts` (`buildConditions`, `upsertCondition` usage for `Accepted`, `InProgress`, `Blocked`, etc.)
  - ImplementationSource webhook controller sets conditions similarly: `services/jangar/src/server/implementation-source-webhooks.ts`.
- No centralized spec exists for condition types and transitions.

## Design
### Recommended condition types
Across reconciled resources:
- `Ready`: resource is valid and reconciled.
- For run-like resources:
  - `Accepted`: controller accepted the run.
  - `InProgress`: work in progress.
  - `Succeeded`: terminal success.
  - `Failed`: terminal failure.
  - `Cancelled`: terminal cancellation (when applicable).
- Optional:
  - `Blocked`: policy/concurrency blocked.

### Transition rules
- Only one terminal condition (`Succeeded`/`Failed`/`Cancelled`) may be `True` at a time.
- `Ready` should be `False` when terminal failure is reached, or be omitted if not meaningful.

## Config Mapping
| Surface | Behavior |
|---|---|
| (code only) | Condition taxonomy is a controller contract; enforce via tests and docs. |

## Rollout Plan
1. Document the taxonomy and update controller code to match.
2. Add unit tests that validate terminal condition exclusivity and stable type names.

Rollback:
- Revert controller changes; keep doc and tests for future alignment.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.status.conditions[*].type}'; echo
kubectl -n agents get agentrun <name> -o jsonpath='{.status.conditions[?(@.type==\"Succeeded\")].status}'; echo
```

## Failure Modes and Mitigations
- Multiple terminal conditions become true: mitigate with a shared condition helper enforcing exclusivity.
- Controllers use inconsistent type strings: mitigate by constants and tests.

## Acceptance Criteria
- Condition types are consistent across CRDs and reconciler code.
- Automation can reliably determine run state from conditions alone.

## References
- Kubernetes API conventions (Conditions): https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties


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
