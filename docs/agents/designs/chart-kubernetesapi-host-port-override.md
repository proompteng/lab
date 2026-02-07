# Chart Kubernetes API Host/Port Override

Status: Draft (2026-02-07)

## Overview
The chart exposes `kubernetesApi.host` and `kubernetesApi.port` which map to `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`. This is a sharp tool: it can help run outside-cluster or in unusual networking environments, but can also break in-cluster discovery if misused.

## Goals
- Document when and how to use the override safely.
- Add guardrails to prevent accidental use in normal in-cluster deployments.

## Non-Goals
- Providing full out-of-cluster deployment support.

## Current State
- Values: `charts/agents/values.yaml` includes `kubernetesApi.host` and `kubernetesApi.port`.
- Templates set env vars for both deployments:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- Default is empty (Kubernetes default service env vars apply).

## Design
### Contract
- In-cluster installs SHOULD leave `kubernetesApi.*` empty.
- If either `kubernetesApi.host` or `kubernetesApi.port` is set, both MUST be set.
- The chart SHOULD validate the above in `values.schema.json`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `kubernetesApi.host` | `KUBERNETES_SERVICE_HOST` | Overrides API endpoint host. |
| `kubernetesApi.port` | `KUBERNETES_SERVICE_PORT` | Overrides API endpoint port. |

## Rollout Plan
1. Add schema validation requiring both host and port together.
2. Add README guidance and examples (in-cluster vs special cases).

Rollback:
- Clear the override values and re-sync.

## Validation
```bash
helm template agents charts/agents | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
kubectl -n agents get deploy agents -o yaml | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
```

## Failure Modes and Mitigations
- Override breaks in-cluster API access: mitigate by default empty + schema guardrails.
- Only host or port set causes confusing behavior: mitigate by schema enforcement.

## Acceptance Criteria
- It is impossible (via schema) to set only one of host/port.
- Operators can identify overrides in rendered manifests.

## References
- Kubernetes in-cluster configuration: https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

