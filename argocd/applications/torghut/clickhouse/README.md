# Keeper storage migration

Keeper's current Ceph RBD log blocks on durable writes. A 60-sample, 4 KiB append-and-fsync comparison in the
same Keeper container measured 1.27 s p95 on its RBD volume and 0.01 s p95 on local storage. This migration
moves Keeper to retained local NVMe claims with native Raft replication across three hosts. Keep `force_sync`
enabled. Do not tune Ceph or weaken ClickHouse insert quorum as part of this migration.

Each stage must complete its reviewed main release, matching-image Kargo promotion and live verification
before the next stage is merged:

1. Enable native reconfiguration on the existing singleton, retain its PVC and take `keeper-pre-nvme-20261105`.
   Verify the snapshot is ready, the original server ID is still 0, and existing ClickHouse replicas remain active.
2. Add only replica 1 on `local-path-keeper`, on a different host. Verify `/keeper/config` includes IDs 0 and 1
   and that the new replica has caught up before starting another replica.
3. Add replica 2 on the third host. Verify all three members agree on membership and serve the existing state.
   Native membership changes must be incremental. Re-read `/keeper/config` after an uncertain response.
4. Only after both new members are caught up, move replica 0 to its own local claim, retaining its original ID,
   hostname, Ceph PVC and snapshot. Let it recover from the surviving majority. Do not replace all claim
   templates at once or start an empty singleton. Allow at most one unavailable member after all three are ready.

If a stage fails, stop adding or replacing replicas and preserve all claims. Recover the existing membership
before continuing; reverting YAML cannot undo a committed Raft membership change. Local volumes cannot move
between hosts. A lost device requires recovery from the surviving Keeper quorum.

Completion requires active ClickHouse replicas, measured Keeper write latency and archive commit latency
under representative load. Argo health and successful replica creation do not establish a performance repair.

The exact deployed Keeper 26.8.2.7 image was rehearsed with synthetic state: singleton, sequential additions,
writes with the original stopped, original restart and recovery onto an empty replacement disk all preserved
the expected value. The rehearsal does not replace production catch-up and post-change measurements.

References: [native membership procedure](https://clickhouse.com/docs/guides/oss/deployment-and-scaling/keeper#converting-a-single-node-keeper-into-a-cluster),
[local storage contract](../../local-path/README.md).
