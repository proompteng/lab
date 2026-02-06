# CRD: Memory Retention and Compaction

Status: Draft (2026-02-06)

## Overview
The `Memory` CRD represents stored context/embeddings. Without retention controls and compaction, memory stores can grow without bound, increasing storage cost and slowing queries. This doc defines retention and compaction semantics managed by controllers.

## Goals
- Provide per-Memory retention policy.
- Define compaction behavior and safety controls.

## Non-Goals
- Defining embedding model selection (separate concern).

## Current State
- Memory CRD exists:
  - Go: `services/jangar/api/agents/v1alpha1/types.go` (Memory types)
  - CRD: `charts/agents/crds/agents.proompteng.ai_memories.yaml`
- Memory runtime and storage code lives in:
  - `services/jangar/src/server/memories.ts`
  - `services/jangar/src/server/memories-store.ts`
- Chart values do not expose memory retention controls.

## Design
### API shape
Add to Memory spec:
```yaml
spec:
  retention:
    maxItems: 10000
    maxAgeDays: 90
  compaction:
    enabled: true
    strategy: "drop-oldest"
```

### Controller behavior
- Periodically scan Memory objects and enforce:
  - Drop items older than `maxAgeDays`
  - Drop oldest beyond `maxItems`
- Emit conditions/events when compaction occurs.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_MEMORY_COMPACTION_ENABLED` | toggle | Enables background compaction loop. |
| `controllers.env.vars.JANGAR_MEMORY_COMPACTION_INTERVAL` | schedule | Controls how often compaction runs. |

## Rollout Plan
1. Add API fields with defaults that preserve current behavior (no compaction unless enabled).
2. Canary in non-prod with a small Memory and verify compaction.
3. Enable in prod with conservative defaults and monitoring.

Rollback:
- Disable compaction loop; stop enforcing retention fields.

## Validation
```bash
kubectl -n agents get memory -o yaml | rg -n \"retention:|compaction:|conditions\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"compaction|retention\"
```

## Failure Modes and Mitigations
- Over-aggressive retention deletes useful context: mitigate with conservative defaults and “dry-run mode” first.
- Compaction loop increases DB load: mitigate with interval controls and batching.

## Acceptance Criteria
- Memory growth can be bounded by policy.
- Compaction is observable and reversible (disable loop).

## References
- Kubernetes controllers (background reconciliation): https://kubernetes.io/docs/concepts/architecture/controller/

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
