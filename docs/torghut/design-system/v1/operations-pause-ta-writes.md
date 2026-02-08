# Operations: Pause TA Writes (Suspend `torghut-ta`)

## Status
- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

## Purpose
Provide an explicit, safe-by-default “stop the bleeding” procedure that an oncall can execute quickly to reduce write
pressure on ClickHouse during incidents (disk pressure, replica read-only, Keeper instability) by suspending the Flink TA
job.

This procedure **does not** change trading safety gates; trading remains paper-by-default and live trading remains gated
by `TRADING_LIVE_ENABLED=false`.

## When to use
- ClickHouse disk pressure alerts (PVC free space low/critical).
- ClickHouse replica read-only alerts.
- Flink TA job failing due to ClickHouse JDBC write errors / retry storms.

## Inputs
- Namespace: `torghut`
- FlinkDeployment: `flinkdeployment/torghut-ta`
- GitOps manifest: `argocd/applications/torghut/ta/flinkdeployment.yaml`

## Procedure A (recommended): GitOps-first suspend/resume
### Suspend (pause TA writes)
1) Edit `argocd/applications/torghut/ta/flinkdeployment.yaml`:
   - set `spec.job.state: suspended`
2) Let Argo CD sync, then verify:
   - `kubectl -n torghut get flinkdeployment torghut-ta`
   - Job state is `SUSPENDED` (or not `RUNNING`) and no new writes occur.

### Resume (restore TA writes)
1) Edit `argocd/applications/torghut/ta/flinkdeployment.yaml`:
   - set `spec.job.state: running`
   - bump `spec.restartNonce` (integer) if a restart is required
2) Let Argo CD sync, then verify:
   - `kubectl -n torghut get flinkdeployment torghut-ta`
   - ClickHouse `max(event_ts)` for `torghut.ta_signals` advances.

## Procedure B (emergency): Direct patch (not source of truth)
Use only if GitOps is blocked and you need to immediately stop write pressure.

Suspend:
```bash
kubectl -n torghut patch flinkdeployment torghut-ta --type merge -p '{"spec":{"job":{"state":"suspended"}}}'
```

Resume:
```bash
kubectl -n torghut patch flinkdeployment torghut-ta --type merge -p '{"spec":{"job":{"state":"running"}}}'
```

Follow-up requirements:
- Immediately open a GitOps PR to reconcile `argocd/applications/torghut/ta/flinkdeployment.yaml` to the desired state.
- Record a short incident note (what triggered the pause, when resumed).

## Safety notes
- Pausing TA may cause signal freshness to degrade (expected); keep trading paused if freshness is uncertain.
- Do **not** relax `TRADING_LIVE_ENABLED` or other live-trading gates as part of this procedure.

## Related runbooks
- Disk guardrails: `v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`
- Replica read-only / Keeper recovery: `v1/operations-clickhouse-replica-and-keeper.md`

