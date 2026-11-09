# Keeper storage

Keeper uses its existing Ceph RBD claim. The local NVMe migration was not activated, and no dedicated Keeper
StorageClass is provisioned. Preserve the existing PVC, server identity and native membership during rollouts.

## Signal schema reconciliation

One wave-3 Sync hook verifies the Signal schemas on both configured ClickHouse replicas before the retained
Flink jobs and publishers can roll out. The hook uses the server's pinned client version and reads the SQL
contracts from a generated ConfigMap. It checks existing columns, engines, keys, retention and the Webull view
before applying anything. A complete replica performs only reads. An incomplete replica applies its local,
idempotent DDL and must pass verification before the runner advances. Replicated table engines retain their
existing Keeper paths and replica identities; application insert quorum and data retention are unchanged.

The former four hooks repeated `ON CLUSTER` DDL concurrently on every sync. During the November 8 failure,
individual statements took 80–157 seconds while each complete hook had a 300-second deadline. The single runner
addresses each replica directly, avoiding distributed DDL queue entries for unchanged objects. Its 30-minute Job
budget includes bootstrap and repair; individual schema statements have a 300-second execution budget and a
360-second receive timeout. A failed verification blocks the release. Retrying resumes from current metadata.

The v1-to-v2 intraday backfill is an explicit historical migration in
[backfill-intraday-bars-v2.sql](backfill-intraday-bars-v2.sql), outside the deployed Kustomization. It is not a
routine release hook. Both production replicas were checked on November 8: all 155,615 retained legacy rows
were represented in v2, and the running archive already wrote v2. Preserve both tables. An operator restoring
older data must run and verify that migration through the existing ClickHouse identity before resuming the
v2 archive; the SQL retains the anti-join coverage assertion and does not erase legacy data.

The native fixture runs the actual schema runner against two disposable ClickHouse replicas and Keeper. It
covers empty bootstrap, a read-only repeat, second-replica view and security drift, recovery after a missing replicated table,
precision-column repair and failure on incompatible extra columns:

```sh
python3 argocd/applications/torghut/clickhouse/tests/schema.py
```
