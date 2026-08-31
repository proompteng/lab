# 23. Trading Startup Readiness Warmup and Rollout Stability (2026-03-04)

## Context

- Torghut Knative revisions (`torghut-00042` -> `torghut-00044`) repeatedly enter startup churn with probe failures, including:
  - `Liveness probe failed.../healthz` (connection refused / timeout).
  - `Readiness probe failed.../readyz` with HTTP 503.
- Readiness currently marks scheduler failures hard as soon as `TradingScheduler.state.running` is false, even while startup tasks are still initializing.
- Existing manifests lacked a startup probe; startup failures can therefore be interpreted by kubelet before the service establishes readiness criteria.

## Problem

Current readiness behavior can restart containers during benign startup latency by requiring immediate readiness. During initialization, dependency contracts and first scheduler warmup work can produce temporary `503` responses, which contributes to unstable revisions and repeated startup loops.

## Decision

Apply a bounded startup grace in readiness and add a Knative `startupProbe`:

1. Add scheduler startup tracking state (`startup_started_at`) in `services/torghut/app/trading/scheduler.py`.
2. Update readiness evaluation in `services/torghut/app/main.py`:
   - If trading is enabled and scheduler is not yet `running`, allow `readyz` to remain optimistic inside `TRADING_STARTUP_READINESS_GRACE_SECONDS`.
   - After grace expires, readiness returns 503 as before unless dependencies are healthy and scheduler is running.
3. Add startup readiness probe configuration to `argocd/applications/torghut/knative-service.yaml`:
   - `/readyz` startup probe with a small retry window before kubelet marks the pod unhealthy.
4. Add regression tests in `services/torghut/tests/test_trading_api.py` for startup grace pass/fail paths.

## Alternatives Considered

1. **Startup-probe-only change** (selected as insufficient)
   - Pros: simple manifest-only change.
   - Cons: still returns `503` readiness during benign startup windows and can trigger unnecessary cold restarts in tight restart budgets.

2. **Liveness/readiness probe delay-only tuning**
   - Pros: low code risk.
   - Cons: delays failure discovery for true dependency regressions and does not encode application startup intent.

3. **Startup grace + startup probe** (selected)
   - Pros: combines explicit startup allowance with readiness semantics tied to process lifecycle.
   - Cons: introduces bounded period where readiness may stay non-strict during bootstrap.

## Tradeoffs

- **Stability gain:** reduces false-negative readiness during initialization and protects startup progress from minor bootstrap transients.
- **Risk window:** readiness may stay accepting for up to `TRADING_STARTUP_READINESS_GRACE_SECONDS` even before first full scheduler loop cycle.
- **Mitigation:** keep grace short and conservative, and maintain dependency checks in readiness after startup grace expires.

## Rollback Plan

- Set `TRADING_STARTUP_READINESS_GRACE_SECONDS=0` to disable startup optimism.
- Remove the Knative `startupProbe` if rollout behavior regresses.
- Revert this file and commit if readiness semantics need to be strict during bootstrap in future.

## Verification

- `services/torghut/app/main.py::_evaluate_trading_health_payload` updated to use warmup allowance with structured scheduler metadata.
- `services/torghut/app/trading/scheduler.py` now tracks startup timing and flips running state at loop entry.
- `services/torghut/tests/test_trading_api.py`
  - `test_readyz_allows_startup_grace_window`
  - `test_readyz_rejects_after_startup_grace_expires`
- `argocd/applications/torghut/knative-service.yaml` startupProbe added for `/readyz`.
