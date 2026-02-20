# Temporal CI Cluster Requirement

## Summary

Temporal integration tests in `@proompteng/temporal-bun-sdk` must run against the shared Temporal cluster managed by ArgoCD.

They must **not** be switched to a local `start-dev` Temporal server in CI.

## Why

- The integration suite assumes shared-cluster behavior and timing characteristics.
- Switching CI to local `start-dev` introduced regressions:
  - hook and scenario timeouts,
  - connection-refused races,
  - unstable harness startup/teardown behavior under parallel test execution.
- This produced false negatives that were unrelated to the production task-queue-kind fix.

## Required CI behavior

- Keep CI pointed at the ArgoCD Temporal endpoint (`TEMPORAL_ADDRESS=temporal-grpc:7233` in current workflow).
- Keep `TEMPORAL_TEST_SERVER=1` in CI for SDK test jobs.
- Keep `TEMPORAL_ENFORCE_REMOTE_ADDRESS=1` in CI so localhost targets fail fast.
- If readiness is slow, improve readiness retries/diagnostics, but do not redirect CI to local Temporal.

## Guardrail for future changes

When touching Temporal CI or test harness code:

1. Do not replace the cluster target with `127.0.0.1`/local dev server in CI.
2. Validate failures first as cluster readiness/connectivity before changing execution mode.
3. Prefer explicit address usage and stronger readiness waiting over topology changes.
4. Keep the workflow "Enforce ArgoCD Temporal target" check in place.
