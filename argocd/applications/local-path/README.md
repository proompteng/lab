# Local-path storage

Existing compute and CI classes remain rebuildable scratch storage. Their prohibited-use annotations continue to
exclude databases and other durable services.

`local-path-ofz-wal` and `local-path-restate-wal` reserve separate directories on the verified NVMe mounts of
Ryzen, Altra and Turin. Both classes use `WaitForFirstConsumer` and `Retain`. Their consumers must retain native
synchronous replication across distinct hosts; these classes provide no replication or failover by themselves.
Check mount identity and actual free space before allocating claims. Local-path does not enforce the requested
capacity or support online expansion. Never rebind a retained local volume to another host or another instance.
The owning [Ofz](../ofz/README.md) and [Restate](../restate/README.md) procedures govern their data migrations.

`local-path-keeper` is reserved for Torghut Keeper replicas. Its explicit NVMe paths are independent of the cache
classes, and its claims use `Retain`. This class does not replicate data: Keeper must commit through its native
Raft quorum across distinct hosts. Never replace the existing singleton's Ceph claim with a local claim. Add and
verify replicas one at a time while preserving the original Keeper identity, state, hostname and Ceph PVC.

`local-path-bayn-wal` is reserved for the WAL volumes of the existing two-instance `bayn-db` and
`bayn-native-arrival-db` clusters. It uses the
mounted Altra local NVMe and Turin Intel NVMe, on the same two 100G hosts required by that cluster. Each node has
one explicit path; it cannot randomly select Turin's CI device or provision on another node. Capacity and mount
identity must be checked before allocating a claim. Local-path does not enforce a filesystem quota or support
online PVC expansion.

This class does not replicate data. Financial durability requires PostgreSQL to acknowledge a commit only after
both the primary and a standby on the other host have flushed it. Bayn must retain required synchronous replication,
hard host anti-affinity, fsync, full-page writes, WAL archiving and its existing backups. A missing standby can block
writes; it cannot authorize asynchronous financial commits. PGDATA remains on its existing Ceph volumes.

The class uses `WaitForFirstConsumer` and `Retain`. Deleting a claim must not delete its financial WAL files.
Do not recycle a retained path or rebind a volume to another instance. A lost local device requires the normal
CloudNativePG standby reconstruction or failover procedure; a local PVC cannot move its bytes to another node.

Sync this application's reviewed revision and verify the provisioner loaded the new configuration before enabling
Bayn's `walStorage`. Adding `walStorage` is a separate, one-way CloudNativePG change: it cannot be removed from an
existing cluster. Preserve the old PGDATA PVCs and let the operator move WAL during its managed rollout. Storage
class readiness alone does not establish commit latency, native decision timeliness or 99.9% reliability.

References: [local-path v0.0.37 configuration](https://github.com/rancher/local-path-provisioner/tree/v0.0.37#configuration),
[CloudNativePG WAL volumes](https://cloudnative-pg.io/docs/1.30/storage/#volume-for-wal),
[required synchronous durability](https://cloudnative-pg.io/docs/1.30/replication/#data-durability-and-synchronous-replication).
