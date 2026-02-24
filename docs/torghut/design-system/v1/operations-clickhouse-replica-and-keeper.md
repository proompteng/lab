# Operations: ClickHouse Replica and Keeper

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

## Purpose

Provide ClickHouse recovery procedures tailored to Torghut’s replicated tables and known operational incidents (keeper
metadata loss leading to read-only replicas and TA downtime).

## Non-goals

- Comprehensive ClickHouse cluster management beyond Torghut usage.

## Terminology

- **Keeper:** Coordination service used by replicated ClickHouse tables (similar to ZooKeeper).
- **Replica read-only:** Replica refuses writes, often due to keeper metadata issues.

## Inputs

- Namespace: `torghut`
- ClickHouse service: `svc/torghut-clickhouse` (HTTP `8123`, native `9000`)
- Keeper installation: `ClickHouseKeeperInstallation/torghut-keeper`
- ClickHouse auth secret: `Secret/torghut-clickhouse-auth` (do not paste values into tickets/docs)

## Current deployed resources (pointers)

- ClickHouse cluster: `argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml`
- Keeper: `argocd/applications/torghut/clickhouse/clickhouse-keeper.yaml`
- TA schema defines replicated tables: `services/dorvud/technical-analysis-flink/src/main/resources/ta-schema.sql`

## Incident reference

- `docs/torghut/ops-2026-01-01-ta-recovery.md` documents keeper metadata loss and recovery via `SYSTEM RESTORE REPLICA`.

## Access (operator)

Preferred access is in-cluster (exec into a ClickHouse pod) or local port-forward.

Local port-forward (HTTP):

```bash
kubectl -n torghut port-forward svc/torghut-clickhouse 8123:8123
```

Password handling (do not echo):

```bash
CH_USER=torghut
CH_PASS="$(kubectl -n torghut get secret torghut-clickhouse-auth -o jsonpath='{.data.torghut_password}' | base64 -d)"
```

Example query:

```bash
curl -fsS 'http://localhost:8123/?query=SELECT%201%20FORMAT%20JSONEachRow' \\
  -H \"X-ClickHouse-User: ${CH_USER}\" \\
  -H \"X-ClickHouse-Key: ${CH_PASS}\"
```

## Procedure A: Replica is read-only

### Symptoms

- TA job fails on inserts.
- ClickHouse errors indicate tables are read-only.

### Steps (operator)

0. Reduce write pressure first (recommended):
   - Pause TA writes by suspending `FlinkDeployment/torghut-ta` (GitOps-first; direct `kubectl patch` is emergency-only).
   - Runbook: `v1/operations-pause-ta-writes.md`
1. Verify keeper is healthy:
   - Check keeper pods/service and logs.
2. Inspect replica state:
   - Query `system.replicas` to find `is_readonly=1`.
3. Restore replica metadata:
   - `SYSTEM RESTORE REPLICA torghut.ta_signals`
   - `SYSTEM RESTORE REPLICA torghut.ta_microbars`
4. Verify replica becomes active (`is_readonly=0`, `active_replicas` correct).
5. Restart Flink TA job after ClickHouse is writable again.

### Useful queries

Replica state:

```sql
SELECT database, table, is_readonly, is_session_expired, future_parts, parts_to_check, queue_size
FROM system.replicas
WHERE database = 'torghut'
FORMAT JSONEachRow;
```

Basic signal freshness:

```sql
SELECT max(event_ts) AS max_event_ts FROM torghut.ta_signals FORMAT JSONEachRow;
```

## Procedure B: Keeper outage

### Symptoms

- Replicated tables become unhealthy; new replicas cannot attach.

### Steps

1. Restore keeper service (pods, PVC, networking).
2. Validate ClickHouse nodes can reach keeper.
3. If metadata was lost, use `SYSTEM RESTORE REPLICA`.

## Procedure C: Disk pressure

See `v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`.

## Verification checklist

- ClickHouse responds to `SELECT 1`.
- `system.replicas` shows `is_readonly=0` for Torghut tables.
- `max(event_ts)` for `torghut.ta_signals` advances once TA is resumed.

## Rollback

- If `SYSTEM RESTORE REPLICA` does not restore writability, keep TA suspended to avoid thrash and escalate:
  - validate Keeper health and connectivity,
  - consider restoring from backups or rebuilding replicas (manual operator work; see `v1/disaster-recovery-and-backups.md`).

## Security considerations

- Restrict access to ClickHouse `SYSTEM` commands.
- Keep ClickHouse endpoints internal; do not expose HTTP externally.

## Decisions (ADRs)

### ADR-23-1: Replica recovery is part of oncall operational procedures

- **Decision:** `SYSTEM RESTORE REPLICA` is an accepted recovery procedure and documented.
- **Rationale:** It was required in a real incident and should not be tribal knowledge.
- **Consequences:** Oncall must have documented access paths and guardrails to execute safely.
