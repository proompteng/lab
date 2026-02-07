# Controller Namespace Scope: Parse + Validate

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
Namespace scoping is a primary safety control for Agents controllers. The controllers accept a namespaces list via env vars (`JANGAR_AGENTS_CONTROLLER_NAMESPACES`, `JANGAR_PRIMITIVES_NAMESPACES`). Invalid JSON or ambiguous inputs can lead to unexpected reconciliation scope.

This doc proposes strict parsing and validation rules plus chart-side guardrails.

## Goals
- Ensure namespace scope parsing is strict, deterministic, and observable.
- Prevent accidental broad scopes due to parsing fallbacks.

## Non-Goals
- Multi-namespace controller architecture changes.

## Current State
- Chart renders namespace lists into env vars:
  - `charts/agents/templates/deployment-controllers.yaml` sets `JANGAR_PRIMITIVES_NAMESPACES` and `JANGAR_AGENTS_CONTROLLER_NAMESPACES` via `agents.controllerNamespaces`.
- Runtime parsing helpers exist in `services/jangar/src/server/agents-controller.ts`:
  - `parseEnvArray`, `parseEnvList`, `parseEnvStringList`.
- Namespace scoping helpers live in `services/jangar/src/server/namespace-scope.ts`.

## Design
### Accepted formats
Support exactly:
- JSON array: `["agents","agents-ci"]`
- Comma-separated list: `agents,agents-ci`

### Validation rules (fail-fast)
- Empty list is invalid unless `rbac.clusterScoped=true` and wildcard `*` is explicitly present.
- Reject invalid JSON (do not silently fall back to CSV).
- Reject namespaces with whitespace or invalid DNS label characters.

### Observability
- Log the resolved namespace list at startup.
- Expose it via a controller health endpoint (if available).

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES` | Canonical scope for agents reconciliation. |
| `controller.namespaces` | `JANGAR_PRIMITIVES_NAMESPACES` | Canonical scope for primitives reconciliation. |

## Rollout Plan
1. Add strict parsing behind a feature flag (warn-only mode).
2. Canary in non-prod by intentionally injecting invalid values and confirming rejection.
3. Promote to fail-fast in prod.

Rollback:
- Disable strict parsing flag.

## Validation
```bash
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES|JANGAR_PRIMITIVES_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"namespaces\"
```

## Failure Modes and Mitigations
- Silent fallback expands scope: mitigate by rejecting invalid JSON rather than falling back.
- Mis-typed namespace blocks controllers startup: mitigate by clear error messages and GitOps revertability.

## Acceptance Criteria
- Invalid namespace scope config results in a clear startup failure.
- Resolved namespaces are logged and testable.

## References
- Kubernetes namespace naming: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/

