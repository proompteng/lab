# Torghut TA/WS Recovery (2026-01-01)

> Note: Canonical production-facing design docs live in `docs/torghut/design-system/README.md` (v1). This document is supporting material and may drift from the current deployed manifests.

## Summary

Recovered torghut TA processing and visuals after ClickHouse replicas went read-only and Jangar pointed to the wrong database. Also stabilized torghut-ws readiness by clearing Alpaca WS connection-limit errors.

## Symptoms

- Flink deployment `torghut-ta` in FAILED state (JDBC write failures to ClickHouse).
- ClickHouse tables `torghut.ta_microbars` and `torghut.ta_signals` read-only due to missing keeper metadata.
- Jangar visuals showed no symbols and `/api/torghut/ta/latest` returned `UNKNOWN_TABLE` for `ta_microbars`.
- torghut-ws readiness stuck at 503 with Alpaca 401/406 errors.

## Root Causes

- ClickHouse replicated tables lost keeper metadata (`/clickhouse/tables/.../log` missing) -> replicas read-only.
- Jangar was configured with `CH_DATABASE=default` but TA tables live in `torghut` database.
- torghut-ws had Alpaca WS connection limit/auth errors; a clean restart was needed.

## Fixes Applied

1. Restore ClickHouse replicas on both CH nodes:
   - `SYSTEM RESTORE REPLICA torghut.ta_signals`
   - `SYSTEM RESTORE REPLICA torghut.ta_microbars`
   - Verified `system.replicas` shows `is_readonly=0`, `active_replicas=2`.
2. Restart Flink TA job after CH recovery:
   - Bumped `restartNonce` on `flinkdeployment/torghut-ta`.
   - Verified job status `RUNNING` and TaskManagers started.
3. Reset torghut-ws:
   - Scaled `deployment/torghut-ws` to 0 then back to 1.
   - Verified readiness `READY 1/1`.
4. Fix Jangar ClickHouse database:
   - Updated `CH_DATABASE=torghut` on `deployment/jangar`.
   - Verified `/api/torghut/ta/latest?symbol=NVDA` returns data.

## Verification

- `kubectl get flinkdeployment -n torghut torghut-ta` -> `RUNNING/STABLE`
- `kubectl get pods -n torghut -l app=torghut-ws` -> Ready
- `curl http://jangar/api/torghut/ta/latest?symbol=NVDA` -> OK payload

## Follow-ups

- Ensure ArgoCD manifests reflect `CH_DATABASE=torghut` to avoid drift.
- Consider alerting on ClickHouse replica read-only state (system.replicas).
