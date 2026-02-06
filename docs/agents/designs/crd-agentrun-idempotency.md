# CRD: AgentRun Idempotency Key Contract

Status: Draft (2026-02-06)

## Overview
AgentRun includes `spec.idempotencyKey`. This field is intended to avoid duplicate runs when clients retry requests. Without a contract (scope, retention, collision handling), the field is under-specified.

This doc defines idempotency behavior and how controllers should implement it.

## Goals
- Ensure a given idempotency key creates at most one effective execution per scope.
- Provide predictable behavior for retries and duplicates.

## Non-Goals
- Exactly-once execution across cluster failures.

## Current State
- Field exists in Go types: `services/jangar/api/agents/v1alpha1/types.go` (`AgentRunSpec.IdempotencyKey`).
- Controller currently deduplicates webhook-driven orchestration submissions via DB store (`orchestration-submit.ts`), but AgentRun idempotency is not explicitly implemented/documented.

## Design
### Scope
- Idempotency key scope is `(namespace, agentRef.name, idempotencyKey)`.

### Behavior
- On creating a new AgentRun:
  - If another AgentRun exists with same scope and is non-terminal: reject creation with a clear error.
  - If terminal: return the existing run reference (or allow new run only if `force=true` via a separate mechanism).

### Implementation approach
- Add an index (DB-side) or controller cache keyed by the tuple above.
- Prefer durable store (DB) so restarts don’t break idempotency.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED` | toggle | Allows phased rollout (default `true`). |
| `controllers.env.vars.JANGAR_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS` | retention | How long to remember keys after terminal completion. |

## Rollout Plan
1. Implement as best-effort in-controller cache (warn-only) in non-prod.
2. Promote to durable store-based enforcement in prod.

Rollback:
- Disable enforcement and rely on client-side de-dupe.

## Validation
```bash
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents get agentrun -o json | rg -n \"idempotencyKey\"
```

## Failure Modes and Mitigations
- Key collisions across unrelated workloads: mitigate by scoping to agentRef and namespace.
- Retention too short allows duplicates: mitigate by conservative default retention and pruning.

## Acceptance Criteria
- Duplicate creates with same idempotency key do not create duplicate effective runs.
- Behavior is consistent across controller restarts.

## References
- HTTP request idempotency (general definition): https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods

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
