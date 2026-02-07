# Chart namespaceOverride vs Release Namespace Behavior

Status: Draft (2026-02-07)
## Overview
The chart uses `namespaceOverride` to force all rendered resources into a namespace different from `.Release.Namespace`. This is useful in some GitOps setups but can be hazardous if only part of a release is overridden (e.g. CRDs are cluster-scoped, but Roles/RoleBindings are namespaced).

This doc defines safe usage and guardrails.

## Goals
- Make namespace selection behavior explicit for all chart resources.
- Prevent accidental “split-brain” installs (resources in multiple namespaces).

## Non-Goals
- Supporting multi-namespace installs from a single Helm release.

## Current State
- Value: `charts/agents/values.yaml` → `namespaceOverride`.
- Most templates set `metadata.namespace: {{ .Values.namespaceOverride | default .Release.Namespace }}`:
  - Examples: `charts/agents/templates/deployment.yaml`, `charts/agents/templates/service.yaml`, `charts/agents/templates/rbac.yaml`.
- GitOps typically installs into namespace `agents` and does not set `namespaceOverride` explicitly.

## Design
### Contract
- If `namespaceOverride` is set, it MUST be used consistently across all namespaced resources in the chart.
- Chart MUST fail render if:
  - `namespaceOverride` is set to an empty/whitespace string.
  - `namespaceOverride` is set but `.Release.Namespace` differs and `createNamespace=false` (optional guardrail depending on GitOps practice).

### Documentation requirement
Add a README section:
- “Do not set `namespaceOverride` unless Argo/Helm release namespace is locked.”

## Config Mapping
| Helm value | Rendered namespace | Intended behavior |
|---|---|---|
| `namespaceOverride: \"\"` | `.Release.Namespace` | Normal Helm behavior. |
| `namespaceOverride: agents` | `agents` | Forces all namespaced resources into `agents`. |

## Rollout Plan
1. Document contract and guardrails.
2. Add schema validation (`minLength: 1` when set).
3. Add template validation for common foot-guns.

Rollback:
- Remove `namespaceOverride`; rely on `.Release.Namespace`.

## Validation
```bash
mise exec helm@3 -- helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"namespace:\"
kubectl get ns agents
```

## Failure Modes and Mitigations
- Resources created in unexpected namespace: mitigate via render review + guardrail validation.
- Argo CD app sync fails due to namespace mismatch: mitigate by keeping release namespace and override aligned.

## Acceptance Criteria
- Rendered manifests place all namespaced resources in exactly one namespace.
- Invalid override values are rejected at render time.

## References
- Helm template rendering concepts: https://helm.sh/docs/chart_template_guide/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
