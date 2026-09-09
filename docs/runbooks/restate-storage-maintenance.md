# Restate storage maintenance

This procedure permits one retained-PVC Pod replacement in the existing three-node Restate 1.7.9 cluster after the
replication migration has completed. Normal desired state keeps `PodDisruptionBudget/restate` at `minAvailable: 3`.
A single owned maintenance operation may temporarily set it to two only after every gate below passes. This is not a
bootstrap change, a StatefulSet downscale, a replication change, or permission to run concurrent disruptions.

## Admission

- Record the cluster context, Application and controller UIDs, exact reviewed Argo revisions, all three Pod/PVC/PV
  identities, node IDs, and CSI kernel principals. Require three Ready Pods on distinct Ready hosts, no rollout,
  and no active Argo synchronization or Kargo promotion.
- Require three alive Restate nodes, identical three-member metadata membership, one metadata leader, replication
  two with all three nodes in every current log nodeset, and one active leader plus one active follower for each of all 24 partitions. Every
  partition must have a positive archived snapshot LSN. Run the existing isolated snapshot restore drill and require
  it to open all 24 latest snapshots successfully in this maintenance window.
- Require Bayn's existing execution worker registration to be Ready, its durable effective authority to be OBSERVE,
  reconciliation EXACT with zero unresolved mutations and no open orders. Preserve the existing authority, kill
  switch, epoch, plan/source binding, request identity, and registration. Never clear a kill switch for maintenance.
- Acquire owned Argo holds for `bayn` and `restate` using the preserved skip-reconcile and Ceph maintenance-owner
  annotations. Require atomic UID/resourceVersion preconditions and refuse another owner's hold. Argo status is
  stale while held; all following checks use native resources and runtime evidence.

## Quiesce and replace

1. Through `RestateDeployment/bayn-execution-controller`, temporarily change only `spec.replicas` from its captured
   value to zero. Restate Operator 3.0.0 supports zero replicas in ReplicaSet mode and propagates the count without
   changing the Pod-template hash or service registration. Require every owned worker ReplicaSet and Pod to be
   stopped, unchanged registration ID, and no new broker mutation. The durable scheduler state remains intact;
   this pauses its worker processes without granting or changing execution authority.
2. Immediately recheck Restate quorum, partition/log replication, archived snapshots, Ceph health and current OSD
   latency. Patch only the captured PDB from three to two, with an owned annotation and UID/resourceVersion plus
   original-value preconditions. Server-side dry-run the exact patch first. Keep both surviving Pods Ready.
3. Replace exactly one selected Pod through the Kubernetes Eviction API with its UID precondition. Use the checked-in
   [CNPG-safe NoSchedule helper](../../scripts/cluster-upgrades/ceph-csi-taint-remount.py) to keep its replacement off the
   old mount until the old Pod UID and RBD kernel mapping are both gone. Do not cordon a database host, force-delete a Pod, delete a VolumeAttachment, or modify a
   PVC/PV. Keep the fence if detachment fails and recover that same operation.
4. Require the same StatefulSet, PVC/PV and RBD identities, a Ready replacement using `csi-rbd-node.3`, and full native
   three-node/24-partition recovery. Restore the PDB to its captured value of three and remove only its owned
   annotation. Repeat admission and the single-Pod procedure for the next mount; never overlap replacements.

Run the helper first without `--execute`, then with it only after the worker and PDB admission steps above. Pass
captured identities explicitly; do not generate replacement identities after a failed operation:

```sh
python3 scripts/cluster-upgrades/ceph-csi-taint-remount.py \
  --context galactic-lan --namespace restate \
  --pod "$RESTATE_POD" --node "$RESTATE_NODE" \
  --expected-pod-uid "$RESTATE_POD_UID" --expected-rbd-image "$RESTATE_RBD_IMAGE" \
  --expected-fsid 5ade350d-92fe-49df-829e-37c1fbaf6c50 \
  --audit-file "$RESTATE_REMOUNT_RECEIPT"
```

The helper preserves unrelated taints and annotations, refuses an unverified CNPG operator/drain configuration, and
checks all twelve database primary identities. Its timeout, interrupted eviction and failed CSI-read paths retain the
owned fence unless both the old Pod UID and old RBD mapping are proven absent. The generic cordon-based
`ceph-csi-remount.py` entrypoint is not the command for this procedure.

## Resume and recovery

After all selected mounts and native checks pass, restore the captured worker replica count through the same
RestateDeployment UID with the unchanged template and registration. Require the worker registration Ready again,
the same durable execution authority/kill state and binding, continuing controller progress, EXACT reconciliation,
zero unresolved mutations, and no new broker orders. Remove only the owned Argo holds and verify fresh reconciliation.

If a gate fails after mutation, retain the exact operation receipt. Restore only fields whose original identity and
ownership are still proven. Keep the PDB at two only while recovering the single interrupted Pod, then restore three.
Do not start another disruption or clear a storage fence while the old mapping remains. Restore worker replicas only
after Restate has full quorum and partition recovery. Never substitute direct state edits, private-handler exposure,
registration replacement, authority changes, or a singleton rollback for this procedure.

For a retained node fence, rerun the same helper and all original target arguments with
`--recover-from "$RESTATE_REMOUNT_RECEIPT" --audit-file "$RESTATE_RECOVERY_RECEIPT"`. This defaults to a read-only
recovery check. Add `--execute` after it passes. Keep the original receipt unchanged. Recovery restores its ownership
token and verifies the original node, controller, PVC/PV/RBD and CNPG identities, current Ceph/CSI health, and absence
of both the old Pod UID and RBD mapping. It only removes that owned fence; it never evicts another Pod. Complete the
replacement/native checks and restore the PDB and worker replicas through the enclosing procedure above.

Restate contracts: [high availability](https://docs.restate.dev/server/deploy/ha),
[snapshot recovery](https://docs.restate.dev/server/deploy/snapshots), and the deployed operator's
[ReplicaSet propagation](https://github.com/restatedev/restate-operator/blob/v3.0.0/src/controllers/restatedeployment/controller.rs).

The verified CNPG 1.30 [default drain taints](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/internal/configuration/configuration.go) exclude the owned storage taint. The helper refuses overrides and version changes.
