# CRD: AgentRun Artifacts Limits and Schema

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

