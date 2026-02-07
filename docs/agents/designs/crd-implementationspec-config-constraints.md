# CRD: ImplementationSpec Runtime Config Constraints

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

