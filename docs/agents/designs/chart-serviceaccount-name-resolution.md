# Chart ServiceAccount Name Resolution

Status: Draft (2026-02-07)

## Overview
The Agents chart supports `serviceAccount.create` and `serviceAccount.name`, plus a separate `runnerServiceAccount` for jobs created by controllers. The naming and resolution rules must be explicit so operators can safely integrate with external IAM (IRSA, Workload Identity) and cluster policy.

## Goals
- Define deterministic ServiceAccount naming and selection for:
  - Control plane pods
  - Controllers pods
  - Runner jobs (if enabled)
- Avoid accidental reuse of default ServiceAccounts.

## Non-Goals
- Cloud-provider-specific IAM automation.

## Current State
- Values: `charts/agents/values.yaml` under `serviceAccount.*` and `runnerServiceAccount.*`.
- Templates:
  - ServiceAccount: `charts/agents/templates/serviceaccount.yaml`
  - Runner ServiceAccount: `charts/agents/templates/runner-serviceaccount.yaml`
  - Pods use `serviceAccountName: {{ include "agents.serviceAccountName" . }}` in both deployments:
    - `charts/agents/templates/deployment.yaml`
    - `charts/agents/templates/deployment-controllers.yaml`
- Runner RBAC: `charts/agents/templates/runner-rbac.yaml`.

## Design
### Naming contract
- If `serviceAccount.create=true` and `serviceAccount.name` is empty:
  - Chart creates `ServiceAccount/<release fullname>`.
- If `serviceAccount.name` is set:
  - Chart uses that name and does not create a new ServiceAccount unless explicitly requested.

### Runner ServiceAccount contract
- If `runnerServiceAccount.create=true`:
  - Chart creates `ServiceAccount/<release fullname>-runner` unless `runnerServiceAccount.name` is set.
- If `runnerServiceAccount.setAsDefault=true`:
  - Controllers default runner jobs to that ServiceAccount via env var mapping (see `charts/agents/templates/deployment-controllers.yaml` for `JANGAR_SCHEDULE_SERVICE_ACCOUNT` and workload defaults).

## Config Mapping
| Helm value | Rendered object/field | Behavior |
|---|---|---|
| `serviceAccount.create=true` | `ServiceAccount` | Create control plane/controllers ServiceAccount. |
| `serviceAccount.name` | `spec.serviceAccountName` | Explicit override of SA used by Deployments. |
| `runnerServiceAccount.create=true` | `ServiceAccount` | Create SA intended for runner Jobs. |
| `runnerServiceAccount.setAsDefault=true` | controller env/runtime | Sets default runner job SA when workload spec omits it. |

## Rollout Plan
1. Document naming in `charts/agents/README.md`.
2. Add chart validation:
   - If `runnerServiceAccount.rbac.create=true`, require `runnerServiceAccount.create=true` or a non-empty name.
3. Add controller-side logging of chosen runner ServiceAccount per Job.

Rollback:
- Revert values; existing ServiceAccounts are safe to keep.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"kind: ServiceAccount|serviceAccountName\"
kubectl -n agents get sa
```

## Failure Modes and Mitigations
- Deployments run as `default` SA unexpectedly: mitigate with schema validation and documented defaults.
- Runner jobs fail RBAC due to SA mismatch: mitigate with explicit runner SA + explicit RoleBindings.

## Acceptance Criteria
- Helm render shows a single, predictable ServiceAccount per component.
- Runner job SA selection is observable in logs and Job specs.

## References
- Kubernetes ServiceAccounts: https://kubernetes.io/docs/concepts/security/service-accounts/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

