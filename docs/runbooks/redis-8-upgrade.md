# Redis 8 upgrade

Buzz and Open WebUI upgrade their existing standalone Redis instances to 8.10.1.
Their Applications consume `kargo/buzz` and `kargo/jangar`: merge the manifests,
wait for their normal image builds and automatic Kargo promotions, then verify
both serving instances and their clients. The Redis operator owns the StatefulSets.

The one-time migration resources in each application's `redis-upgrade-backup.yaml`
enforce this order:

| Wave | Required result |
| --- | --- |
| -3 | Redis answers authenticated PING where configured, SAVE returns OK, and persistence reports success. A connection failure retries within the Job deadline; a failed save stops the rollout. |
| -2 | Create a fresh volume snapshot while retaining the previous upgrade snapshots. |
| -1 | Bind a separate PVC restored from that snapshot. The clone cannot bind before its snapshot is usable. |
| 0 | Restore the clone with the pinned existing Redis version, write a proof key, and shut it down cleanly. Start the actual Redis 8 image against the same AOF and require the proof key, new writes, SAVE, and exporter 1.91.1 metrics with `redis_up=1`. |
| 1 | Update the serving Redis CR to 8.10.1 and its exporter to 1.91.1. |

The rehearsal mounts only its clone, binds Redis and exporter listeners to loopback,
has no Service, and receives no Kubernetes API token. Its proof keys never touch the
serving data. Kubernetes terminates the native Redis and exporter sidecars when the
verification Job finishes. Snapshots and clone PVCs have `Prune=false,Delete=false`;
this rollout does not remove existing data or backups.

Verify each fresh snapshot is Ready, each rehearsal Job is Complete, each serving
Pod has the intended image digest, and both Redis `INFO server` and persistence
report the expected version and successful writes. Check the serving exporter and
exercise Buzz and Open WebUI through their existing endpoints. Pod readiness alone
does not establish that their Redis clients resumed correctly. Record the actual
RBD principal after each serving Pod rollout; a container restart can reuse an old
kernel mapping and does not itself prove the Ceph key migration.

A failed preparation or rehearsal blocks wave 1. Inspect that Job before retrying;
do not bypass it or change the serving image directly. If serving acceptance fails,
retain the original snapshot and halt further upgrades. Restore the original
version onto a separate PVC from its original snapshot and verify it before any
controlled consumer cutover. Do not point Redis 7 at files already rewritten by
Redis 8 or overwrite the original serving PVC to attempt an in-place downgrade.

These resources describe an upgrade of the existing instances, not fresh-cluster
bootstrap. A fresh installation must omit these one-time migration Jobs until its
initial Redis instance exists. Remove completed migration Jobs from desired state
in a subsequent reviewed cleanup while retaining the recorded recovery artifacts.

Redis documents the supported 7.x to 8 standalone path, saving and copying the
persistence files, and testing the upgrade before production in its
[standalone upgrade guide](https://redis.io/docs/latest/operate/oss_and_stack/install/upgrade/standalone/).
