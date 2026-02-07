# CRD: Memory Retention and Compaction

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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

