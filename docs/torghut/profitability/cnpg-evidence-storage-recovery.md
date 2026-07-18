# CNPG Evidence Storage And Recovery

Status: Slice 11 implementation contract. The high-availability rollout and isolated restore drill are not yet
production-proven.

## Observed Baseline

The live readback on `2026-07-18` found a healthy 21 GB PostgreSQL 17 database with data checksums, continuous WAL
archiving, a 14-day recovery window, and successful daily object-store backups. The latest base backup completed in
about 15 minutes. It also found three material gaps:

- the cluster had one instance, so there was no failover replica;
- an old `kubectl-patch` manager still pinned the pod to one hostname even though that selector was absent from Git;
- no isolated restore or measured recovery-time proof existed.

Backup success is not restore proof. One healthy pod and one Ceph-backed PVC are not database high availability.

## Decision

Run one primary and one hot standby on the two amd64 workers, with required hostname anti-affinity. Do not place a
physical replica on the arm64 worker until mixed-architecture compatibility is deliberately proven with the exact
PostgreSQL image and data types. The current two-instance topology is asynchronous: it improves availability but does
not claim zero-loss synchronous failover.

Each instance has a `500m` CPU and `1Gi` memory request plus a `4` CPU and `8Gi` memory limit. Those bounds are above
the observed primary use of roughly `379m` CPU and `453Mi` memory while preventing an unbounded database pod from
consuming a worker. Base backups prefer the standby and fall back to the primary when no standby is available.

CloudNativePG manages `instances - 1` replicas and automated failover whenever `instances` is greater than one. Its
backup guidance states that WAL archiving provides a default disaster-recovery RPO of at most five minutes and that
restore time must be measured regularly. See the official
[capability-level contract](https://cloudnative-pg.io/docs/current/operator_capability_levels/) and
[backup guidance](https://cloudnative-pg.io/docs/current/backup/).

## Ownership Migration

Argo CD uses server-side apply with forced conflict resolution, but omitting a map entry does not delete a value still
owned by another field manager. The rollout therefore has one explicit operational migration after the Git change is
merged and before judging replica placement:

```sh
kubectl -n torghut patch cluster torghut-db --type=json \
  -p='[{"op":"remove","path":"/spec/affinity/nodeSelector"}]'
```

This removes only the stale scheduling pin. It does not restart, delete, or recreate the primary. The committed
architecture affinity and required hostname anti-affinity then become the only scheduling contract. Verify the result
through `metadata.managedFields`, the live Cluster spec, and pod node placement; do not retain a cleanup Job or second
configuration writer.

## Production Proof Sequence

Slice 11 is complete only after all of these pass:

1. focused manifest tests, Kustomize rendering, CRD server dry-run, and CI pass at the merged source;
2. the operator reports two ready instances on distinct amd64 hosts, streaming replication is healthy, and the standby
   lag is measured rather than assumed;
3. a controlled weekend switchover preserves database identity and immutable evidence counts, the read-write Service
   follows the new primary, and the scheduler reconnects without duplicate broker mutation;
4. a base backup completes from the standby and continuous WAL archiving remains healthy;
5. a new isolated CNPG cluster restores the selected backup, verifies database/schema and immutable evidence
   fingerprints, records recovery duration, and is then removed without touching the source cluster.

The isolated restore follows CloudNativePG's rule that recovery bootstraps a new cluster rather than overwriting the
source. See the official [recovery contract](https://cloudnative-pg.io/docs/current/recovery/).

The installed CloudNativePG `1.30.0` operator warns that native Barman object-store support is removed in `1.31`.
Migration to the supported Barman Cloud CNPG-I plugin is therefore a blocking follow-up before the next operator
upgrade; backup availability must not be silently lost during that upgrade.

None of these storage proofs establishes strategy profitability or capital authority. Risk-increasing real-capital
submission remains blocked.
