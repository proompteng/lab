# Operations: Pause TA Writes (Stop the Bleeding)

## Status
- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (deployed config): `argocd/applications/torghut/**`

## Purpose
Provide a fast, safe-by-default procedure for oncall to **pause Torghut TA writes** when ClickHouse is unhealthy (disk
pressure, replica read-only, or sustained JDBC failures). This prevents retry storms and buys time to recover ClickHouse
without taking risky actions.

## Non-goals
- Changing trading safety gates (paper-by-default / live trading remains gated).
- Performing ClickHouse data deletion/partition drops (covered elsewhere).

## Safety invariants (do not violate)
- Do **not** enable live trading. Keep `TRADING_LIVE_ENABLED=false`.
- Prefer keeping trading paused (`TRADING_ENABLED=false`) while TA is paused or signals are stale.

## When to use
Use this procedure when any of the following are true:
- ClickHouse disk free is low (disk pressure alerts firing).
- ClickHouse replicas are read-only (`system.replicas.is_readonly=1`).
- Flink TA job is failing due to ClickHouse write errors and is retrying.

## Inputs
- Namespace: `torghut`
- FlinkDeployment: `flinkdeployment/torghut-ta`
- GitOps manifest: `argocd/applications/torghut/ta/flinkdeployment.yaml`

## Procedure A (fast): emergency pause via kubectl
This takes effect immediately and is appropriate during an active incident.

1) Suspend the TA job:
```bash
kubectl -n torghut patch flinkdeployment torghut-ta --type merge -p '{"spec":{"job":{"state":"suspended"}}}'
```

2) Verify the deployment shows suspended:
```bash
kubectl -n torghut get flinkdeployment torghut-ta
```

3) Confirm write pressure stopped:
- Flink no longer emits JDBC retry loops.
- ClickHouse disk free stops falling (or falls more slowly).

## Procedure B (preferred): persist pause via GitOps
Use this after Procedure A, or when you have time to do the safer persistent change first.

1) Edit `argocd/applications/torghut/ta/flinkdeployment.yaml`:
   - set `spec.job.state: suspended`
2) Argo CD sync the Torghut application and confirm the live resource matches.

## Resume (after ClickHouse is healthy)
Preconditions:
- ClickHouse disk pressure resolved (free space stable, merges progressing).
- Replicas are writable (`system.replicas.is_readonly=0`).

1) Resume the TA job:
```bash
kubectl -n torghut patch flinkdeployment torghut-ta --type merge -p '{"spec":{"job":{"state":"running"}}}'
```

2) If the job does not restart cleanly, bump `restartNonce` to force a fresh restart:
```bash
kubectl -n torghut patch flinkdeployment torghut-ta --type merge -p "{\"spec\":{\"restartNonce\":$(date +%s)}}"
```

3) Verify recovery:
- `kubectl -n torghut get flinkdeployment torghut-ta` shows `RUNNING/STABLE`.
- ClickHouse `max(event_ts)` for `torghut.ta_signals` advances.

## Follow-up requirements
- Reconcile via GitOps so Argo does not revert the emergency patch.
- Record a short incident note (what triggered the pause, when resumed).

## Related runbooks
- ClickHouse disk recovery: `v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`
- ClickHouse replica/keeper recovery: `v1/operations-clickhouse-replica-and-keeper.md`
