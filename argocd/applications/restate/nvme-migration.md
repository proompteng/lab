# Retained Restate data migration to local NVMe

This transition keeps the existing cluster, node names and IDs, signing key, 24 partitions, replication two,
snapshot repository, and Services. It uses the existing `local-path` class. Do not provision another cluster or
disable WAL synchronization. Complete the 1.8.1 software rollout on the original Ceph claims first.

Target placement:

| Pod | Host | Roles | Initial claim |
| --- | --- | --- | --- |
| restate-0 | turin | all | 16Gi |
| restate-1 | talos-192-168-1-194 | metadata, log, admin, ingress | 16Gi |
| restate-2 | talos-192-168-1-85 | all | 16Gi |

Three physical hosts protect metadata quorum from a Turin failure. Two workers keep invocation execution on the
100G hosts. Three log servers with replication two allow another host to acknowledge writes when one is unavailable.
Ryzen's slower link must be included in latency/load acceptance. This is not capacity qualification for future Kafka
ingestion. Local-path requests do not enforce quotas or reserve filesystem space; monitor actual host free space.

## Prepare and replace the immutable StatefulSet definition

1. Verify the exact reviewed source, successful image receipts, selected Kargo Freight, generated `kargo/restate`
   commit, and live image. Save the three Pod/PVC/PV UIDs, PV reclaim policies, native node IDs, metadata membership,
   partition state, registered services, and application state. Require three healthy members, replication two,
   48 active processors, and a successful same-version offline snapshot restore. Preserve all baseline evidence.
2. Protect each original PV with `Retain` using JSON Patch tests for its UID and resourceVersion. Verify the readback
   before deleting any claim. The class defaults to `Delete`, which would otherwise destroy the retained source.
3. Confirm Argo targets the exact reviewed Kargo commit, with no unrelated or previous sync operation active.
   The reviewed transition uses `OnDelete`, a native scheduling gate, and a read-only copy-marker init check.
   Newly created members cannot schedule or open empty storage. Do not change Argo or Kargo automation settings.
4. The claim-template class is immutable. Delete **only the StatefulSet controller** with orphan propagation and a
   UID precondition, retaining all Pods and claims. Reconcile the exact reviewed Kargo commit so Argo recreates
   and adopts the existing Pods. Do not use Argo `Force`/`Replace`, cascade-delete Pods, or deploy checkout manifests.
   Verify all three original Pod UIDs and running processes remain unchanged before continuing.

## Copy one stopped member at a time

Move `restate-0`, then `restate-2`, then `restate-1`. Keep each of the first two on its original host and with its
original roles so the storage latency comparison precedes the third member's placement/role change.

1. Require the other two members healthy and caught up. Before moving `restate-1`, drain its exact native worker ID
   with `restatectl nodes set-worker-state --nodes <id> --worker-state draining --yes`. Wait until its partition
   assignments are empty and the two remaining workers have all 48 active processors.
2. Mark this original claim for deletion, then gracefully delete only its verified Pod UID. Wait for normal kubelet
   termination, disappearance of the old UID, and the RBD attachment to detach. Stop on an unreachable host or uncertain
   writer. Never force-delete a running writer. The replacement must have the scheduling gate and no node assignment.
3. Rebind the retained original PV to a temporary source claim with its original class/access mode and explicit
   `volumeName`. Clear the old claimRef only with tests for the original PV UID and deleted claim UID. Mount the source
   read-only in a temporary Pod pinned to its original 100G host. Never mount a Ceph claim on Ryzen.
4. Recreate the original `storage-restate-N` claim using `local-path`, 16Gi, and its target selected-node annotation.
   Mount it in a temporary destination Pod pinned by node affinity, with the exact compute-local toleration only for
   Ryzen. Verify the bound PV's node affinity and host path resolve to the intended NVMe device. Protect it with `Retain`.
5. Stream GNU tar between the source and destination Pods over authenticated `kubectl exec`. Preserve hardlinks,
   permissions, numeric ownership, ACLs and extended attributes. Compare SHA-256 manifests of every regular file,
   symlink targets, modes, ownership, and hardlink groups. Require both stream processes to succeed and `sync` the
   destination. No source or destination Restate process may run during this copy.
6. Write `/restate-data/.verified-nvme-copy` containing the exact Pod name only after verification and sync it.
   Remove both temporary copy Pods and wait for their UIDs to disappear. Remove only this replacement Pod's scheduling
   gate with UID/resourceVersion tests. The init check then admits the verified copy.
7. Require the original native node ID in a new live generation, identical three-member metadata membership,
   replication two, 48 active partition processors and fresh successful application work before moving another member.
   The metadata/log-only member must have `has_worker_role=false` and zero assignments. Retain the original source
   volume until the complete migration and recovery acceptance pass.

The startup probe is read-only. The existing replication hook remains the activation writer and skips worker
activation for members without that native role.

## Finish and prove the result

Promote a reviewed final revision that restores `RollingUpdate`, removes the scheduling gate and copy-marker init,
and requires host separation across the three local claims. Remove copy markers and temporary claims/Pods after
acceptance. Retire the original RBD sources only after all copied data and cluster/application
continuity are verified. Do not leave transition controls or a second storage implementation in final desired state.

Compare exported WAL fsync sum/count deltas and append latency under comparable operation counts and load. Record
source/image, host/device, window timestamps and counts. Upgrade, storage, and role/placement changes are separate
variables. A successful sync or Ready Pod is not a performance result. Exercise application work with one member
unavailable in an isolated rehearsal before any authorized production failure test.

If a copy or admission check fails, leave the replacement scheduling-gated and preserve both volumes. Keep the original
RBD source read-only on its original 100G host. Fix the copy, permissions, target device or admission failure, repeat
the full offline verification, and write the marker only on the verified NVMe destination before releasing its gate.
Do not restore an RBD claim under this template or write a marker to the protected source. This migration fixes forward
to one storage implementation. If the replacement already started, fence and stop that writer before another copy;
reconcile any work acknowledged since its admission through the surviving native log replicas rather than overwriting
newer state with the older source. Stop moving additional members if quorum or data continuity fails. Never provision
empty state, lower replication, disable fsync or discard retained data to make readiness pass.

Upstream contracts: [clusters and nodesets](https://docs.restate.dev/server/clusters),
[rolling updates](https://docs.restate.dev/server/upgrading#rolling-updates),
[configuration](https://docs.restate.dev/server/configuration).
