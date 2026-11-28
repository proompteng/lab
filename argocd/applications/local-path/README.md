# Local-path storage

General node-local claims use `local-path`; AMD64 CI scratch uses `local-path-ci-amd64`.
Neither class replicates data. Retained PostgreSQL WAL uses the separate class described below.

AMD64 CI scratch is restricted to Ryzen and Turin. Turin's CI allocations use the dedicated directory
`/var/lib/kubelet/ci-amd64` on its large system NVMe. Its general `local-path` allocations use
`/var/local-path-provisioner` on that same filesystem; the directory separates ownership, not I/O.
The small Intel and Transcend devices remain reserved for explicit retained workloads. Existing bound volumes
keep their original paths. Kafka's static volumes are owned by the [Kafka application](../kafka/README.md),
not this provisioner.

Before enabling Turin in ARC, sync this application's reviewed revision and verify that the provisioner loaded
the CI mapping. ARC's existing scratch initializer checks the XFS mount and requires 45 GiB free after seeding
each new claim. The claim size is not a quota: check node free space and actual build I/O before raising concurrency.

`local-path-bayn-wal` is reserved for the WAL volumes of the existing two-instance `bayn-db` and
`bayn-native-arrival-db` clusters. It uses the
mounted Altra local NVMe and Turin Intel NVMe, on the same two 100G hosts required by that cluster. Each node has
one explicit path; it cannot randomly select Turin's CI device or provision on another node. Capacity and mount
identity must be checked before allocating a claim. Local-path does not enforce a filesystem quota or support
online PVC expansion.

This class does not replicate data. Financial durability requires PostgreSQL to acknowledge a commit only after
both the primary and a standby on the other host have flushed it. Bayn must retain required synchronous replication,
hard host anti-affinity, fsync, full-page writes, WAL archiving and its existing backups. A missing standby can block
writes; it cannot authorize asynchronous financial commits. PGDATA keeps its existing claims; inspect each bound
PV's storage class, path and host affinity before planning a move.

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

## Ledger volume retention

`bayn-ledger-retention.yaml` sets `persistentVolumeReclaimPolicy: Retain` on core `v1` PersistentVolumes
created or updated with storage class `local-path` and claim references to exactly `bayn/data-ledger-0`,
`bayn/data-ledger-1` or `bayn/data-ledger-2`. It covers dynamic volumes and the static retained handoff volume
without depending on a provisioner annotation. Other claims and storage classes keep their existing policy.

Tigresse's `deletionPolicy: Retain` preserves claims when the cluster object is deleted; it does not set the
PV reclaim policy if a claim itself is deleted. The cluster's storage class is immutable, so this admission policy
protects its existing class without changing the shared StorageClass or granting the operator PV permissions.
Deleting a protected claim leaves its volume and ledger files for explicit recovery or retirement. Retention does
not replicate data, prevent device failure or authorize reformatting or deleting a retained path.

Admission is not retroactive: inspect the three currently bound PVs and correct any `Delete` policy with an
identity-guarded `Retain` patch. Preserve PV and claim UIDs, paths, node affinity and ledger files. Verify both
matching and unrelated requests with server-side dry runs after syncing the policy and binding.
