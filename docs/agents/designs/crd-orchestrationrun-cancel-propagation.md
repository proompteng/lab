# CRD: OrchestrationRun Cancel Propagation

Status: Draft (2026-02-06)

## Overview
Operators need reliable cancellation semantics for OrchestrationRuns. Cancelling should propagate to all active underlying runtimes (Jobs/Workflows/etc) and update status/conditions in a predictable way.

## Goals
- Define cancel request API and status transitions.
- Ensure cancel propagates to underlying resources best-effort.

## Non-Goals
- Guaranteeing immediate termination in all runtimes.

## Current State
- OrchestrationRun CRD exists:
  - `charts/agents/crds/orchestration.proompteng.ai_orchestrationruns.yaml`
- Controller: `services/jangar/src/server/orchestration-controller.ts`
- Orchestration submission stores externalRunId in DB: `services/jangar/src/server/orchestration-submit.ts`.

## Design
### API shape
Add:
```yaml
spec:
  cancel: true
```
or a `spec.desiredState: Cancelled`.

### Controller behavior
- If cancel requested:
  - Attempt to delete/terminate underlying runtime resources.
  - Set `status.phase=Cancelled` and condition `Cancelled=True` once cancellation is acknowledged.
  - If already terminal success/failure: ignore cancel request (no-op) and record a condition reason.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_ORCHESTRATION_CANCEL_TIMEOUT_MS` | bound | Upper bound for cancellation attempts before marking cancelled anyway. |

## Rollout Plan
1. Implement cancel semantics in controller with a feature flag.
2. Canary in non-prod by cancelling a running orchestration and confirming propagation.

Rollback:
- Disable cancel support flag; rely on manual deletion of underlying resources.

## Validation
```bash
kubectl -n agents patch orchestrationrun <name> --type=merge -p '{\"spec\":{\"cancel\":true}}'
kubectl -n agents get orchestrationrun <name> -o yaml | rg -n \"Cancelled|phase\"
```

## Failure Modes and Mitigations
- Underlying runtime ignores deletion: mitigate by best-effort termination + clear status messaging.
- Cancel flips terminal success incorrectly: mitigate by making cancel a no-op for terminal runs.

## Acceptance Criteria
- Cancelling a running OrchestrationRun results in a terminal Cancelled state and best-effort runtime termination.
- Cancel is a no-op for already terminal runs.

## References
- Kubernetes graceful termination concepts: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Go API types: `services/jangar/api/agents/v1alpha1/types.go`
- CRD generation entrypoint: `services/jangar/api/agents/generate.go`
- Generated CRDs shipped with the chart: `charts/agents/crds/`
- Examples used by CI/local validation: `charts/agents/examples/`

### Regenerating CRDs

```bash
# Regenerates `charts/agents/crds/*` via controller-gen, then patches/normalizes CRDs.
go generate ./services/jangar/api/agents

# Validates CRDs + examples + rendered chart assumptions.
scripts/agents/validate-agents.sh
```

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

### Rollout plan (GitOps)
1. Regenerate CRDs and commit the updated `charts/agents/crds/*`.
2. Update `charts/agents/Chart.yaml` `version:` if the CRD changes are shipped to users; keep GitOps pinned version in sync (`argocd/applications/agents/kustomization.yaml`).
3. Merge to `main`; Argo CD applies updated CRDs (`includeCRDs: true`).

### Validation
- Local:
  - `scripts/agents/validate-agents.sh`
  - `mise exec helm@3.15.4 -- helm lint charts/agents`
- Cluster (requires kubeconfig):
  - `mise exec kubectl@1.30.6 -- kubectl get crd | rg 'agents\.proompteng\.ai|orchestration\.proompteng\.ai|approvals\.proompteng\.ai'`
