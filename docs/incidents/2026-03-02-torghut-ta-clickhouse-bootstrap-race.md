# Incident Report: Torghut TA ClickHouse Bootstrap Race and Schema Initialization Failure

- **Date**: 2 Mar 2026 (UTC)
- **Detected by**: `trading/status` and runtime logs (`clickhouse_http_404`)
- **Reported by**: gregkonush
- **Services Affected**: `torghut-ta` (Flink TA output path), `torghut` trading/autonomy lane, `torghut-keeper` (ClickHouse Keeper)
- **Severity**: High (autonomy lane entered emergency stop; TA-backed signal ingestion unavailable)

## Impact Summary

- TA Flink job remained `RUNNING`, but ClickHouse-backed signal reads in `torghut` failed.
- Trading/autonomy loop entered repeated failure and latched emergency stop.
- `trading/status` exposed stale `autonomy_last_error` and `emergency_stop_active=true`.

## User-Facing Symptom

`GET /trading/status` reported:
- `autonomy_last_error`: `clickhouse_http_404 ... Database torghut does not exist`
- `failure_streak`: increased past rollback threshold
- `rollback.emergency_stop_active`: `true`

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-02 02:31:19 | `FlinkDeployment/torghut-ta` created. |
| 2026-03-02 02:31:20 | TA jobmanager pod started. |
| 2026-03-02 02:32:08-02:32:14 | TA schema bootstrap failed repeatedly with `UnknownHostException: torghut-clickhouse.torghut.svc.cluster.local`; retried 4 times, then gave up. |
| 2026-03-02 02:34:50 | `Service/torghut-clickhouse` created (after TA already abandoned schema init). |
| 2026-03-02 07:09 | Live remediation phase 1: created fallback `MergeTree` TA tables (`torghut.ta_microbars`, `torghut.ta_signals`) on both ClickHouse replicas to restore reads quickly. |
| 2026-03-02 07:18 | Diagnosed Keeper unavailability root cause: `ImagePullBackOff` on `clickhouse/clickhouse-keeper:24.3.5.46` due Docker Hub unauthenticated pull rate limit (`429 Too Many Requests`). |
| 2026-03-02 07:21 | Patched live Keeper image to internal mirror and reconciled `StatefulSet` to `1` replica; Keeper endpoints became available. |
| 2026-03-02 07:26-07:32 | Live remediation phase 2: dropped fallback TA tables and re-applied canonical replicated schema (`ReplicatedReplacingMergeTree`) via `ta-schema.sql` `ON CLUSTER default`; transient `clickhouse_http_404` observed during table recreation window. |
| 2026-03-02 07:32+ | No further TA table-not-found errors observed; `torghut-ta` remained `RUNNING/STABLE`; Keeper-backed cluster DDL probe succeeded. |

## Root Cause

Primary root cause was startup-order fragility in TA ClickHouse schema initialization, amplified by Keeper pull failure:

1. **Bootstrap ordering race**
   - TA started before `torghut-clickhouse` service DNS was available.

2. **Schema init retry budget too small and non-fatal**
   - TA schema init attempted only 4 times (derived from `TA_CLICKHOUSE_MAX_RETRIES=3`) with 2s delay.
   - After retries exhausted, code logged error and continued startup, leaving runtime in a degraded state.

3. **No later schema reconciliation path**
   - Once startup schema init was skipped/failed, no controller/job retried schema creation after dependencies became ready.

4. **Keeper image supply dependency on Docker Hub**
   - Keeper image source was Docker Hub (`clickhouse/clickhouse-keeper:24.3.5.46`) without an internal mirror in GitOps.
   - During rollout, Docker Hub unauthenticated pull limits caused `ImagePullBackOff`, leaving Keeper at `0` effective endpoints and blocking replicated DDL.

## Contributing Factors

- ClickHouse Keeper was not serving endpoints during the incident window (`keeper` services had no endpoints, statefulset observed at `0/0`), making replicated `ON CLUSTER` DDL unavailable.
- The emergency fallback to non-replicated tables restored service quickly but introduced temporary schema drift from intended replicated topology.
- Runtime health looked superficially good at the pod/Flink level (`RUNNING`), masking data-plane failure until trading/autonomy checks failed.

## Corrective Actions Taken (Live)

1. Created `torghut` database and fallback TA tables (`MergeTree`) on both ClickHouse replicas to restore read path compatibility.
2. Identified Keeper `ImagePullBackOff` root cause (`429` Docker Hub rate limit) and patched live Keeper image to internal mirror.
3. Reconciled Keeper to running state (`1/1`) and verified Keeper endpoints were populated.
4. Recreated TA tables from canonical schema (`ta-schema.sql`) with `ON CLUSTER default`, restoring `ReplicatedReplacingMergeTree` engines on both replicas.
5. Validated in-cluster Keeper-backed DDL (`CREATE/DROP DATABASE ... ON CLUSTER default`) succeeded.

## Durable Fixes Implemented (Repo)

1. Added dedicated schema-bootstrap controls to TA Flink config:
   - `TA_CLICKHOUSE_SCHEMA_INIT_MAX_RETRIES`
   - `TA_CLICKHOUSE_SCHEMA_INIT_RETRY_DELAY_MS`
   - `TA_CLICKHOUSE_SCHEMA_INIT_STRICT`
2. Updated schema init behavior to fail startup when strict mode is enabled and schema cannot be ensured after retry budget.
3. Set Torghut TA defaults to a larger retry window and strict mode:
   - max retries: `180`
   - retry delay: `2000ms`
   - strict: `true`
4. Pinned Keeper image in GitOps to internal mirrored digest to avoid Docker Hub pull-rate failure:
   - `registry.ide-newton.ts.net/lab/clickhouse-keeper:24.3.5.46@sha256:23bc68f765052b59a19e56e5e18b2ecb7cfc23a51ef901b59cd78a0f759c200c`

## Validation

- `kubectl get flinkdeployments.flink.apache.org -n torghut` showed TA `RUNNING` / `STABLE`.
- Keeper resources healthy (`StatefulSet` ready, service endpoints populated).
- Keeper-backed cluster DDL probe succeeded (`CREATE/DROP DATABASE ... ON CLUSTER default`).
- ClickHouse tables exist on both replicas with replicated engines:
  - `torghut.ta_microbars` -> `ReplicatedReplacingMergeTree`
  - `torghut.ta_signals` -> `ReplicatedReplacingMergeTree`
- No post-remediation `clickhouse_http_404` for missing TA tables observed after schema reapply window.
- Targeted regression tests passed:
  - `./gradlew :technical-analysis-flink:test --tests 'ai.proompteng.dorvud.ta.flink.RetryHelperTest'`
  - `./gradlew :technical-analysis-flink:test`
  - `./gradlew :technical-analysis-flink:compileKotlin`

## Preventive Follow-Ups

1. Add guardrail alert for Keeper availability (`keeper` endpoints empty / `StatefulSet replicas=0`) in Torghut ClickHouse health checks.
2. Add explicit post-deploy schema verification check (DB/tables existence and table engine type) as part of Torghut smoke validation.
3. Add preflight verification for image provenance/mirror reachability on critical stateful dependencies (Keeper, ClickHouse).
4. Consider moving schema bootstrap to a dedicated, dependency-aware job/hook so startup does not rely on narrow in-process race windows.

## References

- TA config: `argocd/applications/torghut/ta/configmap.yaml`
- TA runtime bootstrap logic: `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTechnicalAnalysisJob.kt`
- TA env config model: `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTaConfig.kt`
- ClickHouse infra manifests: `argocd/applications/torghut/clickhouse/`
- Keeper image pin: `argocd/applications/torghut/clickhouse/clickhouse-keeper.yaml`
