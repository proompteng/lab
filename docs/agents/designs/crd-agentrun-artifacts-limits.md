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
