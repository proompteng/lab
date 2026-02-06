# Controller Reconcile Timeout Budget

Status: Draft (2026-02-06)

## Overview
Agents controllers perform multiple external operations during reconciliation (Kubernetes API calls via `kubectl`, VCS calls, webhook parsing, database operations). Today, timeouts are mostly implicit (subprocess defaults, library defaults), which makes tail-latency and hung reconciles hard to diagnose.

This doc proposes explicit, configurable timeout budgets for key controller operations.

## Goals
- Make controller timeouts explicit and configurable.
- Prevent a single hung subprocess/API call from stalling reconciliation.
- Provide clear failure behavior and retry guidance.

## Non-Goals
- Changing controller concurrency/throughput policies (covered elsewhere).

## Current State
- Kubernetes calls are executed via spawned `kubectl` processes:
  - `services/jangar/src/server/primitives-kube.ts` (`runCommand`, `kubectl(...)`)
  - Watch loop uses `kubectl get --watch`: `services/jangar/src/server/kube-watch.ts` (uses `--request-timeout=0`)
- Controllers orchestration submission touches the DB store and Kubernetes: `services/jangar/src/server/orchestration-submit.ts`.
- Helm templates do not set any timeout env vars beyond existing feature toggles: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Proposed env vars (controllers only)
- `JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` (default `30000`)
- `JANGAR_CONTROLLER_DB_TIMEOUT_MS` (default `15000`)
- `JANGAR_CONTROLLER_EXTERNAL_TIMEOUT_MS` (default `30000`) for provider calls/webhooks where applicable

### Implementation sketch
- Wrap `runCommand()` in `primitives-kube.ts` with an `AbortController`/timer and kill the child process on timeout.
- Ensure timeout errors:
  - Have a stable `reason`/prefix (e.g. `Timeout: kubectl apply exceeded ...`) for log filtering.
  - Are classified as retryable vs non-retryable (see Failure Modes).

## Config Mapping
| Helm value (proposed) | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` | `JANGAR_CONTROLLER_KUBECTL_TIMEOUT_MS` | Upper bound for `kubectl` subprocess calls. |
| `controllers.env.vars.JANGAR_CONTROLLER_DB_TIMEOUT_MS` | `JANGAR_CONTROLLER_DB_TIMEOUT_MS` | Upper bound for DB operations in controller flows. |

## Rollout Plan
1. Add env var support with defaults that match current practical behavior (no effective change).
2. Canary in non-prod by injecting an artificial delay and confirming timeouts trip.
3. Tune defaults based on observed p95/p99.

Rollback:
- Set timeouts to a high value (or remove env vars) to approximate current behavior.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_CONTROLLER_.*TIMEOUT\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"Timeout:\"
```

## Failure Modes and Mitigations
- Timeout too low causes flakey reconciles: mitigate by conservative defaults + per-environment overrides.
- Timeout too high hides hangs: mitigate by explicit budgets and warnings at 80% of budget.
- `kubectl` process leaks on timeout: mitigate by kill + wait + defensive cleanup.

## Acceptance Criteria
- A hung `kubectl` call cannot stall reconciliation indefinitely.
- Operators can tune timeout budgets via Helm values.

## References
- Kubernetes API timeouts (client-side considerations): https://kubernetes.io/docs/reference/using-api/api-concepts/

