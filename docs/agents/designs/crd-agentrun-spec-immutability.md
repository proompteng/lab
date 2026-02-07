# CRD: AgentRun Spec Immutability Rules

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

