# Chart Runner ServiceAccount Defaulting

Status: Draft (2026-02-07)
## Overview
Agents controllers schedule Kubernetes Jobs for agent runs. The chart includes a `runnerServiceAccount` block and multiple runtime defaults (`runtime.scheduleServiceAccount`, workload defaults, and controller env vars). The defaulting hierarchy must be explicit so operators can ensure jobs run with the intended permissions.

## Goals
- Define a single, deterministic defaulting chain for runner Jobs.
- Avoid accidental privilege escalation (jobs using a more-privileged SA than intended).

## Non-Goals
- Replacing per-run workload overrides in CRDs.

## Current State
- Values:
  - `runnerServiceAccount.*` in `charts/agents/values.yaml`
  - `runtime.scheduleServiceAccount` in `charts/agents/values.yaml`
  - `controller.defaultWorkload.serviceAccountName` in `charts/agents/values.yaml`
- Template mappings (controllers):
  - `JANGAR_SCHEDULE_SERVICE_ACCOUNT` from `runtime.scheduleServiceAccount`: `charts/agents/templates/deployment-controllers.yaml`
  - default workload SA: `JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT` from `controller.defaultWorkload.serviceAccountName`: `charts/agents/templates/deployment-controllers.yaml`
- Runtime uses these env vars while creating Jobs: `services/jangar/src/server/agents-controller.ts`.

## Design
### Defaulting chain (recommended)
1. `AgentRun.spec.workload.serviceAccountName` (per-run explicit)
2. `Agent.spec.security.allowedServiceAccounts` (policy gate; deny if not allowed)
3. `controller.defaultWorkload.serviceAccountName` (cluster/operator default)
4. `runtime.scheduleServiceAccount` (legacy compatibility)
5. Fallback: chart-created `runnerServiceAccount` when `runnerServiceAccount.setAsDefault=true`

### Chart changes
- Prefer a single chart value that maps to the controller default runner SA, e.g.:
  - `runner.defaultServiceAccountName`
and deprecate `runtime.scheduleServiceAccount` for job execution.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.defaultWorkload.serviceAccountName` | `JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT` | Primary default SA for agent-run Jobs. |
| `runtime.scheduleServiceAccount` | `JANGAR_SCHEDULE_SERVICE_ACCOUNT` | Legacy/secondary default; should be deprecated for Jobs. |
| `runnerServiceAccount.setAsDefault` | (chart behavior) | If enabled, set the above to created runner SA name. |

## Rollout Plan
1. Document the defaulting chain in chart README and in controller logs.
2. Add warnings when legacy `runtime.scheduleServiceAccount` is used for Jobs.
3. Introduce the new `runner.defaultServiceAccountName` value and migrate GitOps values.

Rollback:
- Keep both env vars supported; revert to legacy configuration.

## Validation
```bash
mise exec helm@3 -- helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT|JANGAR_SCHEDULE_SERVICE_ACCOUNT\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT|JANGAR_SCHEDULE_SERVICE_ACCOUNT\"
```

## Failure Modes and Mitigations
- Job runs under an unintended SA: mitigate by making the defaulting chain explicit and enforcing allowed-service-accounts policy.
- Missing SA causes Job create failure: mitigate with schema validation and chart-created SA defaults.

## Acceptance Criteria
- Render output shows exactly one “default runner SA” configured for controllers.
- Controller logs indicate the SA used for each created Job.

## References
- Kubernetes ServiceAccounts: https://kubernetes.io/docs/concepts/security/service-accounts/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
