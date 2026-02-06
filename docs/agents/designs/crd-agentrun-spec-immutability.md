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
