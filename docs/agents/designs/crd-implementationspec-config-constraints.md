# CRD: ImplementationSpec Runtime Config Constraints

Status: Draft (2026-02-06)

## Overview
ImplementationSpec contains runtime configuration that is later executed by controllers/runners. Without constraints, it is easy to create specs that are invalid or unsafe (e.g., missing required fields, invalid enum values, or overly large embedded configs).

This doc defines validation constraints and how to phase them in safely.

## Goals
- Improve CRD validation so invalid ImplementationSpecs fail fast.
- Avoid breaking existing specs via opt-in validation phases.

## Non-Goals
- Building a full policy engine for ImplementationSpecs.

## Current State
- Go types: `services/jangar/api/agents/v1alpha1/types.go` (ImplementationSpec types live in the same API package).
- Generated CRD: `charts/agents/crds/agents.proompteng.ai_implementationspecs.yaml`.
- Controller uses ImplementationSpecs during run submission:
  - `services/jangar/src/server/agents-controller.ts` (resolves ImplementationSpecRef / inline implementation).

## Design
### Validation constraints (examples)
- Enums for runtime type already exist for AgentRun runtime (`workflow|job|temporal|custom`); extend similarly where needed.
- Add size limits:
  - `maxProperties` on config maps
  - `maxLength` on strings that can grow unbounded
- Add CEL rules to enforce mutual exclusivity patterns (like existing systemPrompt vs systemPromptRef).

### Phased enforcement
- Add new validations as warnings first (controller condition) before baking into CRD schema.
- Once confirmed, move into CRD `x-kubernetes-validations` (CEL).

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_IMPLEMENTATIONSPEC_VALIDATE_STRICT` | strictness | If true, invalid specs are marked Ready=False and blocked from execution. |

## Rollout Plan
1. Add controller-side validations + Ready=False conditions.
2. After a canary window, promote the most important constraints into the CRD schema.

Rollback:
- Disable strict validation env var and revert schema change if needed (requires CRD management plan).

## Validation
```bash
kubectl -n agents get implementationspec -o yaml | rg -n \"spec:|x-kubernetes-validations\"
```

## Failure Modes and Mitigations
- Schema changes reject previously accepted objects: mitigate by phased controller-first validation and careful CRD upgrades.
- Overly strict constraints block legitimate use: mitigate by documenting intent and providing escape hatches when safe.

## Acceptance Criteria
- Invalid ImplementationSpecs are rejected or clearly marked not-ready before execution.
- The most common spec errors are caught by CRD validation, not runtime failures.

## References
- Kubernetes CRD validation rules (CEL): https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation-rules

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
