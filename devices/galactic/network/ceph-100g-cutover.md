# Ceph 100G cutover

The operator explicitly authorized proceeding on 2026-10-10 despite Altra's 108 C NIC temperature and 81 degraded
PGs. This accepts a possible storage outage during OSD restarts or a NIC thermal shutdown. Do not treat that
exception as the normal procedure for future maintenance. Normal maintenance requires cooling and full replication.

Keep OSD IDs, disks, pools, replica counts, PVCs, management addresses, and the public Flannel network intact.
Only OSD replication, recovery, and cluster heartbeats move to `10.100.0.0/24`.

The subsequent [pod routing change](pod-100g-routing.md) also carries Altra–Turin application and public Ceph client
traffic over 100G. It preserves the public endpoint addresses and keeps Ryzen on the LAN.

## Ordered rollout

1. Merge the host/CNI prerequisites. Render the exact merged Omni template with fresh private secrets; validate,
   inspect the two storage patches, and sync through Omni. Require `storage0` and the host addresses on both nodes.
   Sync only the root Application's `bootstrap` ApplicationSet to that reviewed revision. Require Multus and
   Whereabouts on all nodes, one available reconciler, and the `rook-ceph/ceph-cluster-100g` network definition.
2. Create diagnostic pods selecting that network on Altra and Turin. Verify their secondary addresses, bidirectional
   connectivity, and ordinary Flannel DNS/Service connectivity. Never select the storage network on Ryzen.
3. Freeze all six OSD Deployments with `ceph.rook.io/do-not-reconcile=true` before merging either OSD rollout phase.
   Verify all six carry the label. Merge and sync the attachment phase: retain the default Ceph provider, add the OSD Multus annotation, and
   temporarily set `skipUpgradeChecks: true`. Rook v1.20.7 forces one OSD update at a time with that override.
   It bypasses both the clean-PG gate and `ok-to-stop`; restarting an OSD holding the only available copy can make
   affected PGs temporarily inactive. Release exactly one OSD using the commands below. Require its replacement to
   return up/in in Ceph before releasing another; Kubernetes Deployment readiness alone is insufficient.
4. Require all six OSD pods to have a `10.244.*` primary address and a `10.100.0.*` secondary address. Ceph still
   advertises its old cluster addresses in this phase. This supplies cross-network reachability during conversion.
5. Freeze all six again, then merge and sync the provider phase: `network.provider: multus`, cluster selector
   `rook-ceph/ceph-cluster-100g`, and cluster address range `10.100.0.0/24`. Leave the public selector unset and retain
   existing messenger settings. Remove the temporary manual attachment annotation in this same phase so it cannot
   override Rook's generated annotation. This changes the pod template and makes Rook restart each selected OSD with
   the new cluster binding. Release and verify one OSD at a time again.
   Verify six OSDs return up/in and all
   cluster addresses move to `10.100.0.*`; public addresses must remain `10.244.*`.
6. Merge and sync the restoration phase: remove `skipUpgradeChecks`.
   Keep `upgradeOSDRequiresHealthyPGs: true`, then remove the temporary Deployment freeze labels. The provider now
   owns the same attachment; no compatibility path remains.
7. Verify replication/recovery increments counters on the 100G links. Exercise an RBD/CephFS write, fsync, and
   checksum readback. Record actual results separately from configuration convergence; do not claim 100G throughput
   from carrier speed alone.

Before each OSD rollout phase, freeze all six:

```bash
kubectl --context galactic-lan -n rook-ceph label deployment -l app=rook-ceph-osd ceph.rook.io/do-not-reconcile=true --overwrite
kubectl --context galactic-lan -n rook-ceph get deployment -l app=rook-ceph-osd -L ceph.rook.io/do-not-reconcile
```

For each OSD ID 0 through 5, freeze all again, release only the selected OSD, then restart the operator so its cached
skip set contains the other five. Do not release another until the selected OSD's replacement has the intended
network and a fresh `ceph osd dump` reports it up/in. If it fails, all other OSDs remain frozen.

```bash
osd_id=0
kubectl --context galactic-lan -n rook-ceph label deployment -l app=rook-ceph-osd ceph.rook.io/do-not-reconcile=true --overwrite
kubectl --context galactic-lan -n rook-ceph label deployment "rook-ceph-osd-${osd_id}" ceph.rook.io/do-not-reconcile-
kubectl --context galactic-lan -n rook-ceph rollout restart deployment rook-ceph-operator
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump --format json
```

After the restoration phase, remove the freeze labels from all six Deployments. Useful readback:

```bash
kubectl --context galactic-lan -n rook-ceph label deployment -l app=rook-ceph-osd ceph.rook.io/do-not-reconcile-
kubectl --context galactic-lan -n kube-system get ds kube-multus-ds whereabouts
kubectl --context galactic-lan -n kube-system get deploy whereabouts-reconciler
kubectl --context galactic-lan -n rook-ceph get network-attachment-definition ceph-cluster-100g
kubectl --context galactic-lan -n rook-ceph get pods -l app=rook-ceph-osd -o wide
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump --format json
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph status
```

## Recovery

If a replacement cannot attach or an OSD does not return, stop further updates and inspect CNI events and daemon
logs. Keep Multus, Whereabouts, the network definition, and all disk state in place. Correct the network prerequisite
before resuming. Never delete the CephCluster, purge an OSD, or zap a disk to fix networking.

To return cluster traffic to Flannel, retain both interfaces on every OSD while changing Ceph's cluster binding back
through a reviewed GitOps change. Roll OSDs one at a time, verify all advertised cluster addresses and client I/O,
then remove the secondary attachment. A field revert without mixed-network reachability is insufficient.

## Cutover acceptance, 2026-10-11 UTC

All six OSDs returned active/up/in with `10.244.*` public and `10.100.0.*` cluster addresses. Established OSD TCP
connections use the storage subnet; both hosts' `storage0` counters increased during recovery and test I/O with zero
reported errors or drops. CephFS 8 MiB writes and fsync passed on all three nodes, followed by checksums of every
file from every node. RBD 8 MiB write and fsync on Altra passed checksum readback on fresh Turin and Ryzen mounts.
These are connectivity and data checks, not a peak-bandwidth benchmark. Cooling, PCIe capacity, switch counters,
ordinary Turin pod DNS, full replication, and scrub completion remain separate acceptance items in the hardware plan.

Rook's [network guide](https://github.com/rook/rook/blob/v1.20.7/Documentation/CRDs/Cluster/network-providers.md)
requires old and restarted pods to remain mutually reachable. Its CRD reference carries a conflicting support
warning; this operator-authorized conversion is not a claim of upstream support. The single-OSD behavior of the
temporary override is in [Rook's update code](https://github.com/rook/rook/blob/v1.20.7/pkg/operator/ceph/cluster/osd/update.go).
