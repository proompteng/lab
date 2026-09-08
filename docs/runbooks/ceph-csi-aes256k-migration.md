# Ceph CSI AES256K migration

This procedure completes the CSI credential migration for `galactic-lan`,
Ceph FSID `5ade350d-92fe-49df-829e-37c1fbaf6c50`, in namespace `rook-ceph`.
The existing PVCs, PVs, pools, and data remain in place.

## Compatibility and completed preparation

Talos 1.14 includes the [Ceph AES256K kernel backport](https://github.com/siderolabs/pkgs/commit/84c1b8752ef16f78f5893fe3b0de7a9288c58d7d)
on both architectures. Its patched Linux 6.18 kernel supports this migration;
the upstream Linux 7.0 minimum alone is not a valid compatibility check.

The reviewed preparation in commit `90ad405b503220972387c8e449f4fe8146e2a39f`
requests CSI generation 3, `keyType: aes256k`, and `keepPriorKeyCountMax: 2`.
On September 8, 2026, Rook reported those reconciled values. All four generated
CSI Secrets referenced `.3` identities. Seven storage acceptance Jobs at that
exact revision succeeded at 08:16:10 UTC: RBD and CephFS write/remount checks
across all three nodes, plus an RGW conditional write/read check. Recheck current
state before maintenance; these results do not prove existing mounts migrated.

With secure CSI keys reconciled, `cephConfig.mon.mon_auth_allow_insecure_key`
is explicitly `"false"`. This prevents creation of additional insecure keys;
it does not remove retained identities or prohibit existing AES clients from
authenticating. Keep AES in the allowed cipher set until all old mounts migrate.
Ceph's [key-creation guard](https://github.com/ceph/ceph/blob/v20.2.4/src/mon/AuthMonitor.cc#L1440-L1459)
enforces the distinction. Recovery that deliberately creates another AES
generation would first require a reviewed reversal of this creation restriction.

## Existing mounts require unstaging

[Rook's key rotation procedure](https://rook.io/docs/rook/latest/Storage-Configuration/Advanced/cephx-key-rotation/)
states that new keys apply to new mounts. Existing mounts retain their old keys.
A CSI DaemonSet restart does not replace those kernel clients. A workload Pod
restart on the same node can also reuse an existing CSI staging mount.

Before maintenance, inventory each node's RBD devices and kernel Ceph client
identity, map them to PVs and consuming Pod UIDs, and include CephFS staging
mounts and raw block volumes. At 08:13 UTC, 85 active RBD devices still used
the unsuffixed or `.2` identity. Both identities must be treated as old after
generation 3, including mounts created during earlier application rollouts.

For an ordinary, controller-managed Pod with exclusively owned filesystem RBD
claims, the maintenance sequence is:

1. Confirm all nodes and CSI plugins are Ready, monitor quorum has three
   members, all six OSDs are up/in, and every PG is active and clean. Confirm
   generation 3 is reconciled and both prior generations remain retained.
2. Verify the exact Pod UID, owner, node, PVCs, RBD image names, readiness, and
   applicable PodDisruptionBudgets. Record the node's scheduling state and
   refuse a node already cordoned or owned by another maintenance operation.
3. Temporarily cordon that node with a unique ownership annotation and an
   atomic resource-version check. Evict the selected Pod through the Kubernetes
   eviction API with its UID precondition. Preserve PDB enforcement.
4. Wait for the old Pod UID to disappear **and** each corresponding RBD device
   to be unmapped on that node. A deleted Pod or detached VolumeAttachment alone
   does not establish that the old kernel client was removed.
5. Restore the recorded scheduling state only while the ownership annotation
   still matches this operation. Uncordon only a node this operation cordoned;
   preserve unrelated maintenance state. Verify a replacement belonging to the same
   controller uses the same claims, becomes Ready, and maps each image with
   `csi-rbd-node.3`. Check the service's own replication or functional behavior.
6. Refresh the inventory before choosing the next Pod. Stop after any failed
   eviction, incomplete unstage, unexpected owner, or failed acceptance.

If an error occurs after cordoning, restore the scheduling state owned by this
operation and retain the old keys. A failure may leave a replacement using an
old staging mount; record that outcome and repeat inventory before retrying.
Never remove old keys to force a client to reconnect.

The repository helper implements this sequence for one ordinary Pod. Read the
current Pod/PVC/PV and kernel mapping before supplying the explicit identities:

```sh
python3 scripts/cluster-upgrades/ceph-csi-remount.py \
  --context galactic-lan --namespace <namespace> --pod <pod> --node <node> \
  --expected-pod-uid <uid> --expected-rbd-image <csi-vol-uuid> \
  --expected-fsid 5ade350d-92fe-49df-829e-37c1fbaf6c50 \
  --audit-file /tmp/ceph-remount-plan.json
```

Repeat `--expected-rbd-image` for each RBD claim. The default is a read-only
plan; `--execute` performs the reviewed maintenance and requires an audit file.
The audit records the node ownership token, each phase, and failure state.
An already migrated target completes without eviction. The helper refuses
shared claims, raw block volumes, operator-managed Pods, and exhausted PDBs.
It verifies the replacement on its actual node and requires unchanged PVC/PV
UIDs plus the exact `csi-rbd-node.3` principal.

The diagnosed retained BlueStore alert requires explicit
`--allow-bluestore-alert`. This records the exception while still requiring all
six OSD latency samples at or below 75 ms, full monitor quorum, and clean PGs
before and after maintenance. It does not mute the warning or make strict
storage acceptance pass. Any unrecognized warning remains a blocker.

## Workloads requiring a separate procedure

- CNPG primaries, Kafka, Restate, and other operator-managed databases require
  their own maintenance and replication gates. A PDB rejection is a stop signal;
  do not delete the PDB or force Pod deletion.
- Shared CephFS mounts require coordinating every consumer of the old staging
  mount. Restarting one consumer while another still uses it cannot retire that
  kernel client. Verify the old mount and client disappear before rescheduling
  the group, then verify the new CephFS client identity and file readback.
- Raw block volumes and virtual machines require their owning controller's
  shutdown or migration procedure and a verified device release.
- Naked Pods and active Jobs must not be evicted under the assumption that a
  workload controller will recreate them.
- Single-instance workloads with a zero-disruption PDB require an explicit,
  reviewed maintenance sequence. The ordinary eviction helper must refuse them.

## Retire old credentials after migration

Keep `keepPriorKeyCountMax: 2` throughout maintenance. Prove that no node has
an unsuffixed or `.2` RBD/CephFS kernel client and that CSI userland operations
use the current Secrets before reducing retention to zero through GitOps.
Use `ceph auth dump-keys -f json` for key-type metadata; do not print key material.

After old identities have been removed and every relevant key reports
`aes256k`, restrict `security.cephx.allowedCiphers` to `[aes256k]` in a separate
reviewed change. Verify insecure-client, allowed-cipher, and creatable-key
warnings clear. Retained rotating service keys expire separately; verify that
warning clears without muting it.

Run the strict storage acceptance helper and the functional canaries again.
Report any remaining health warning separately. In particular, the BlueStore
slow-operation alert observed at 08:04 UTC can remain in Ceph's retained health
window after current I/O latency recovers; an auth migration does not clear that
independent warning.
