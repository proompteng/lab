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
| 0 | Copy the pristine clone into fresh disposable storage, restore it with the pinned existing Redis version, write a proof key, and shut it down cleanly. Start the actual Redis 8 image against the same AOF and require the proof key, new writes, SAVE, and exporter 1.91.1 metrics with `redis_up=1`. |
| 1 | Update the serving Redis CR to 8.10.1 and its exporter to 1.91.1. |

Each rehearsal Pod mounts its pristine clone read-only and copies its files to a new
`emptyDir`. Redis only writes to that disposable copy. Recreating a failed Job
therefore starts with the original snapshot data, including after a Redis 8 failure.
The Buzz rehearsal includes the serving Redis ConfigMap, preserving its memory
limit and eviction policy. Open WebUI uses the same image defaults as its server.

The rehearsal binds Redis and exporter listeners to loopback,
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

For an empty namespace, use the checked-in Kustomize components
`argocd/bootstrap/buzz` and `argocd/bootstrap/jangar`. They remove all migration
Jobs, snapshots and clone PVCs, and select the pinned Redis 7 source version at
wave -7, before its clients. Use them only when the corresponding serving PVC
does not exist; never select Redis 7 for an existing Redis 8 PVC. The serving PVCs
are `buzz/buzz-redis-buzz-redis-0` and
`jangar/jangar-openwebui-redis-jangar-openwebui-redis-0`.

Keep the ApplicationSet source paths, `kargo/buzz` and `kargo/jangar` revisions,
and synchronization policies unchanged. Bootstrap selection belongs to the
application Kustomization that Kargo promotes:

1. Verify the serving PVC named above is absent in the new namespace. In
   `argocd/applications/buzz/kustomization.yaml` or
   `argocd/applications/jangar/kustomization.yaml`, add a `components` list with
   `../../bootstrap/buzz` or `../../bootstrap/jangar`, respectively, and commit it.
2. Wait for the normal publisher, matching Warehouse Freight and Stage promotion.
   Kargo copies that exact commit and selects the bootstrap component on its
   delivery branch. Require the source Redis PVC to be Bound, Redis to be Ready,
   and PING and persistence checks to pass.
3. Commit removal of that component entry from the same application Kustomization.
   The next normal publisher and Kargo promotion select the guarded Redis 8
   migration. Jangar's automatic synchronization can see this change only after
   Kargo publishes the promoted branch; the root Application never switches paths.
   Buzz's Stage invokes its existing `argocd-update`.

Both publishers and Warehouses include the application and bootstrap directories.
Each first-phase or return-phase selection therefore follows the same image,
Freight, Stage and Argo delivery path as production. No manual deployment, dummy
commit or live-state renderer lookup is needed.

Remove completed migration Jobs from desired state in a subsequent reviewed cleanup
while retaining the recorded recovery artifacts. Retire the bootstrap components
with that migration so they cannot later select an obsolete source version.

Redis documents the supported 7.x to 8 standalone path, saving and copying the
persistence files, and testing the upgrade before production in its
[standalone upgrade guide](https://redis.io/docs/latest/operate/oss_and_stack/install/upgrade/standalone/).
