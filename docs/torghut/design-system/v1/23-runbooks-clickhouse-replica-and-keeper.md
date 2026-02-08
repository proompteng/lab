# Runbooks: ClickHouse Replica and Keeper

## Purpose
Provide ClickHouse recovery procedures tailored to Torghut’s replicated tables and known operational incidents (keeper
metadata loss leading to read-only replicas and TA downtime).

## Non-goals
- Comprehensive ClickHouse cluster management beyond Torghut usage.

## Terminology
- **Keeper:** Coordination service used by replicated ClickHouse tables (similar to ZooKeeper).
- **Replica read-only:** Replica refuses writes, often due to keeper metadata issues.

## Current deployed resources (pointers)
- ClickHouse cluster: `argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml`
- Keeper: `argocd/applications/torghut/clickhouse/clickhouse-keeper.yaml`
- TA schema defines replicated tables: `services/dorvud/technical-analysis-flink/src/main/resources/ta-schema.sql`

## Incident reference
- `docs/torghut/ops-2026-01-01-ta-recovery.md` documents keeper metadata loss and recovery via `SYSTEM RESTORE REPLICA`.

## Runbook A: Replica is read-only
### Symptoms
- TA job fails on inserts.
- ClickHouse errors indicate tables are read-only.

### Steps (operator)
1) Verify keeper is healthy:
   - Check keeper pods/service and logs.
2) Inspect replica state:
   - Query `system.replicas` to find `is_readonly=1`.
3) Restore replica metadata:
   - `SYSTEM RESTORE REPLICA torghut.ta_signals`
   - `SYSTEM RESTORE REPLICA torghut.ta_microbars`
4) Verify replica becomes active (`is_readonly=0`, `active_replicas` correct).
5) Restart Flink TA job after ClickHouse is writable again.

## Runbook B: Keeper outage
### Symptoms
- Replicated tables become unhealthy; new replicas cannot attach.

### Steps
1) Restore keeper service (pods, PVC, networking).
2) Validate ClickHouse nodes can reach keeper.
3) If metadata was lost, use `SYSTEM RESTORE REPLICA`.

## Runbook C: Disk pressure
See `v1/08-component-clickhouse-capacity-ttl-and-disk-guardrails.md`.

## Security considerations
- Restrict access to ClickHouse `SYSTEM` commands.
- Keep ClickHouse endpoints internal; do not expose HTTP externally.

## Decisions (ADRs)
### ADR-23-1: Replica recovery is part of oncall runbooks
- **Decision:** `SYSTEM RESTORE REPLICA` is an accepted recovery procedure and documented.
- **Rationale:** It was required in a real incident and should not be tribal knowledge.
- **Consequences:** Oncall must have documented access paths and guardrails to execute safely.

