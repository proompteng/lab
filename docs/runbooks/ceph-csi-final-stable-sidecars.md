# Ceph CSI compatibility and acceptance

Rook 1.20.7 owns the CSI image set through
`argocd/applications/rook-ceph/operator-values.yaml`. Use its bundled provisioner
6.2.0 and resizer 2.1.0. A newer individual release is not sufficient evidence
that the complete storage combination has been qualified.

## Version authority and compatibility

| Component                        | Selected version | Basis                                             |
| -------------------------------- | ---------------- | ------------------------------------------------- |
| Rook operator and cluster charts | 1.20.7           | Published stable chart                            |
| Ceph                             | 20.2.4           | Supported Tentacle release                        |
| Ceph CSI operator / driver chart | 1.0.4            | Published release                                 |
| Ceph CSI driver                  | 3.17.1           | Rook chart default                                |
| Provisioner                      | 6.2.0            | Rook chart default; no override                   |
| Resizer                          | 2.1.0            | Rook chart default; no override                   |
| Attacher / registrar             | 4.12.0 / 2.17.0  | Rook chart defaults                               |
| Snapshotter                      | 8.6.0            | Explicit earlier override; chart default is 8.5.0 |

The [Rook 1.20 prerequisites](https://rook.io/docs/rook/v1.20/Getting-Started/Prerequisites/prerequisites/)
support Kubernetes 1.31 through 1.37 and both cluster architectures. Its
[CephCluster specification](https://rook.io/docs/rook/v1.20/CRDs/Cluster/ceph-cluster-crd/#cluster-settings)
supports Ceph Squid and Tentacle. However, the exact
[Ceph CSI 3.17.1 test matrix](https://github.com/ceph/ceph-csi/blob/v3.17.1/README.md#known-to-work-co-platforms)
lists Kubernetes 1.34 through 1.36. Rook support and local Kubernetes 1.37
acceptance do not extend that separate upstream test matrix. Record both facts;
do not describe the whole combination as certified by every upstream project.

The snapshotter 8.6.0 override is already deployed alongside the cluster's
VolumeGroupSnapshot APIs. Completed snapshot/restore rehearsals provide local
evidence for that override. The entire image set is therefore not an unmodified
chart bundle. Its source and acceptance must remain explicit in future upgrades.

## Withdrawal of the optional helper overrides

[PR #14509](https://github.com/proompteng/lab/pull/14509) pinned provisioner 6.3.0
and resizer 2.2.1 beyond the chart defaults. The official images, architecture
manifests, Kubernetes API requirements, rendered resources, and server dry run
were checked. Those checks did not prove the combined runtime behavior.

The image ConfigMap reached those pins, while all four controller Pods continued
to run 6.2.0 and 2.1.0. The
[CSI operator 1.0.4 controller](https://github.com/ceph/ceph-csi-operator/blob/v1.0.4/internal/controller/driver_controller.go)
reads that ConfigMap during reconciliation but does not watch its updates. Argo
`Synced/Healthy` therefore did not mean the newer helpers were running.

Remove those two overrides through reviewed GitOps and verify that the resulting
ConfigMap matches the running controller images. This withdraws an unactivated
change; it does not downgrade a running binary. No image-trigger annotations or
operator restart are needed for this withdrawal. Keep the Ceph/CSI driver, node
plugins, key generation, storage classes, RBAC, topology, and existing volumes.

For later chart upgrades, inspect the actual controller and node Pod images after
reconciliation. An image ConfigMap alone is not rollout evidence. Investigate a
remaining image mismatch before declaring the chart update complete.

## Live acceptance

1. Require exact-head CI and review, then let the Rook Argo Application reconcile
   the merged source. Check its rendered image ConfigMap and every actual CSI
   controller image; record native provisioner/resizer version output.
2. Record Ceph health, CSI node Pod UIDs, controller images, volume attachments,
   bound claims, and active consumers. Require `HEALTH_OK`, three monitors in
   quorum, six OSDs up/in, clean PGs, generation 3 with AES256K keys, and no muted
   health checks. Preserve existing volume identities and node Pod UIDs.
3. Provision fresh, uniquely named 1 GiB RBD and CephFS claims in `rook-ceph` using
   the existing storage classes and one isolated Pod per claim. Write a marker,
   expand each mounted claim to 2 GiB, and verify PVC capacity, filesystem size,
   and exact marker readback. Do not resize production claims.
4. Repeat Ceph/security and active-consumer checks. Remove only the new canary
   resources with normal deletion and recorded UID preconditions after their
   successful proof. Preserve earlier migration checkpoints and recovery data.

The strict `scripts/cluster-upgrades/storage-csi-acceptance.sh` helper also counts
retained failed migration Pods as consumers. If historical terminal Pods are the
only failures, record the helper's failed result separately from active-consumer
verification. Preserve their exact UIDs, terminal states, lack of running
containers, and the newer successful proof that supersedes them. An unready
active consumer or a Ceph security warning still blocks acceptance.

## Recovery and release limits

If a canary fails, preserve its evidence and inspect events and controller/node
logs before changing versions. Never force-delete a Pod, PVC, PV, or
VolumeAttachment to clear a symptom. Do not revert Ceph data, keys, or mounted
application volumes as a side effect of a controller-image correction.

At the 2026-09-10 12:00 UTC release cutoff, attacher 4.13.0 and registrar 2.18.0
had release tags but no published official container tags. Registry checks
returned `MANIFEST_UNKNOWN`; retain published 4.12.0 and 2.17.0 images. Do not
substitute staging images. Provisioner 6.3.0 and resizer 2.2.1 are available but
are not required to complete the latest Rook chart upgrade.

- [Rook bundled images and customization guidance](https://rook.io/docs/rook/v1.20/Storage-Configuration/Ceph-CSI/custom-images/)
- [Exact Rook 1.20.7 chart defaults](https://github.com/rook/rook/blob/v1.20.7/deploy/charts/rook-ceph/values.yaml)
- [Attacher 4.13.0 release](https://github.com/kubernetes-csi/external-attacher/releases/tag/v4.13.0)
- [Registrar 2.18.0 release](https://github.com/kubernetes-csi/node-driver-registrar/releases/tag/v2.18.0)
