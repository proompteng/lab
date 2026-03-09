# Incident Report: Torghut TA Kafka Restore Stall and Trading Emergency Stop

- **Date**: 2026-03-09 (UTC)
- **Severity**: High
- **Services affected**: `torghut-ta` (Flink TA lane), `torghut` trading/autonomy runtime

## Impact

- Fresh TA outputs stopped advancing even though `torghut-ws` continued ingesting quotes and trades into Kafka.
- Torghut trading entered and held `rollback.emergency_stop_active=true`, so no new decisions or executions were submitted.
- Live mode remained enabled, but order submission was correctly blocked by stale-signal guardrails.

## User-visible Symptoms

- `GET /trading/status` showed:
  - `signal_continuity.last_state=actionable_source_fault`
  - `signal_continuity.last_reason=cursor_tail_stable`
  - `rollback.emergency_stop_active=true`
  - `rollback.emergency_stop_reason=signal_lag_exceeded:<seconds>`
- `trade_decisions` and `executions` had no new rows in the incident window.
- ClickHouse `torghut.ta_signals` and `torghut.ta_microbars` stopped advancing after `2026-03-06 21:59:08 UTC`.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-09 07:07:41 | `torghut-ta` Flink job reached terminal `FAILED` state after exhausting restart attempts. |
| 2026-03-09 07:07:41 | Job logs recorded `Timeout expired after 60000ms while awaiting InitProducerId` during Kafka exactly-once sink restore. |
| 2026-03-09 13:30:03 | Torghut trading latched emergency stop on `signal_lag_exceeded`. |
| 2026-03-09 15:28 | Live diagnosis confirmed `torghut-ws` was still producing Kafka traffic while TA outputs in ClickHouse remained stale. |
| 2026-03-09 15:30 | Emergency reconcile initiated on `FlinkDeployment/torghut-ta` by bumping `spec.restartNonce`. |
| 2026-03-09 15:32:56 | Flink resubmitted `torghut-technical-analysis-flink` job `ab7064f6dd3a858abc138b5f8927c5cd`. |
| 2026-03-09 15:33 | Job reached `RUNNING`; four taskmanagers came up and TA processing resumed. |
| 2026-03-09 15:34:20 | Torghut cleared emergency stop automatically after fresh-signal recovery cycles completed. |
| 2026-03-09 15:35:23 | Fresh `ta_signals` rows observed again in ClickHouse. |

## Root Cause

Primary root cause was a transactional Kafka sink restore failure in the TA Flink job:

1. `torghut-ta` used `TA_KAFKA_DELIVERY_GUARANTEE=EXACTLY_ONCE`, which enabled transactional Kafka sinks for the
   derived TA topics.
2. During restore from externalized state, Kafka producer initialization stalled with
   `Timeout expired after 60000ms while awaiting InitProducerId`.
3. After the fixed-delay restart budget was exhausted, the Flink job remained failed and TA output topics/ClickHouse
   sinks stopped advancing.
4. Torghut trading correctly treated the stale TA lane as a safety fault and blocked submissions via emergency stop.

## Contributing Factors

1. The derived TA output path was already effectively at-least-once end-to-end because ClickHouse sinks are
   non-transactional and rely on replacing/dedup-friendly storage semantics.
2. The operational cost of transactional restore failure was high: one failed TA job disabled live trading even though
   ingest remained healthy.
3. Emergency live patches to `FlinkDeployment/torghut-ta` were subject to Argo reconciliation, so they were useful for
   recovery but not durable by themselves.

## Recovery Actions Taken (Live)

1. Confirmed the failure boundary:
   - `torghut-ws` logs showed active Kafka produce traffic.
   - `torghut.ta_signals` and `torghut.ta_microbars` in ClickHouse were stale.
   - Torghut `/trading/status` showed emergency stop on `signal_lag_exceeded`.
2. Reconciled `FlinkDeployment/torghut-ta` to restart the TA jobmanager and resubmit the Flink application.
3. Verified:
   - Flink job `RUNNING`
   - all four TA taskmanagers healthy
   - fresh TA rows in ClickHouse
   - Torghut emergency stop cleared automatically after recovery cycles

## Durable Fixes Implemented (Repo)

1. Switched the TA derived Kafka sinks from `EXACTLY_ONCE` to `AT_LEAST_ONCE` in:
   - `argocd/applications/torghut/ta/flinkdeployment.yaml`
   - `argocd/applications/torghut/ta-sim/flinkdeployment.yaml`
2. Changed the TA runtime default delivery guarantee to `AT_LEAST_ONCE` in:
   - `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTaConfig.kt`
3. Updated operator-facing TA docs to reflect that the production TA lane now prioritizes availability and dedup-tolerant
   recovery over transactional Kafka output semantics.

## Why This Fix Is Correct

- TA output topics are derived streams, not the system of record.
- ClickHouse storage for TA outputs already uses `ReplicatedReplacingMergeTree` keyed by `(symbol, event_ts, seq)`,
  which is designed to tolerate duplicate writes.
- Torghut trading consumes the recovered read path through ClickHouse/status guardrails, so availability of fresh signals
  is more important than transactional publication on the derived Kafka topics.
- Removing Kafka transactions from TA sinks eliminates the `InitProducerId` restore dependency that caused this outage.

## Validation Evidence

- Live after recovery:
  - `GET /trading/health` returned `status=ok`
  - `GET /trading/status` returned `signal_continuity.last_state=signals_present`
  - `rollback.emergency_stop_active=false`
- Flink REST:
  - job `ab7064f6dd3a858abc138b5f8927c5cd` reached `RUNNING`
  - `40/40` tasks running
- ClickHouse:
  - fresh `torghut.ta_signals` rows observed after recovery
- Argo:
  - application `torghut` returned `Synced / Healthy / Succeeded`

## Residual Notes

- No immediate new `trade_decisions` or `executions` were observed in the first few minutes after recovery. At incident
  close this was consistent with strategy conditions rather than an active platform fault.

## Follow-up Actions

1. Add alerting on TA job state transitions to `FAILED` before stale-signal guardrails accumulate for hours.
2. Add an operator-visible metric or status field exposing the active TA Kafka delivery profile (`AT_LEAST_ONCE` vs
   transactional) so runtime semantics are obvious during incident triage.
3. Consider a controller-safe GitOps workflow for TA restart actuation so emergency reconciles do not race Argo.
