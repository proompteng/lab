# Final Ceph CSI sidecar update

This update advances the published external provisioner from 6.2.0 to 6.3.0 and
external resizer from 2.1.0 to 2.2.1. Both multi-architecture images are pinned by
digest in `argocd/applications/rook-ceph/operator-values.yaml`. Kubernetes 1.37
satisfies the provisioner's Kubernetes 1.34 minimum for the GA
VolumeAttributesClass API. No feature gates change.

The image values change two entries in
`rook-csi-operator-image-set-configmap`. Kustomize also copies those exact values
to annotations on the two Driver resources. Updating these watched resources
causes the CSI operator to reconcile the RBD and CephFS controller Deployments. Ceph 20.2.4, Rook 1.20.7, Ceph CSI 3.17.1, node
plugins, key generation, storage classes, RBAC, topology, and existing volumes
retain their configuration.

## Rollout and acceptance

1. Complete the earlier Flink savepoint restoration and support/vLLM native
   acceptance before merging this storage change. Require exact-head CI and
   automatic review, then let the existing Rook Argo Application reconcile.
2. Before the controller rollout, record Ceph health, the CSI node Pod UIDs,
   controller image set, volume attachments, bound claims, and active consumers.
   Require `HEALTH_OK`, three monitors in quorum, all six OSDs up/in, clean PGs,
   CSI generation 3 with AES256K keys, and no muted health checks.
3. Verify both controller Deployments use the exact provisioner/resizer digests
   and are available. Verify all CSI node Pods retain their UIDs and all active
   storage consumers remain healthy.
4. Provision fresh, uniquely named 1 GiB RBD and CephFS canary claims in the
   existing `rook-ceph` namespace. Use the existing storage classes and an
   isolated Pod per claim. Write a unique marker, expand each mounted claim to
   2 GiB, and verify PVC capacity, filesystem size, and exact marker readback.
   Do not resize production claims or change storage-class parameters.
5. Record native canary results and repeat Ceph/security and active-consumer
   checks. Remove only the newly created canary resources with normal deletion
   after matching their recorded UIDs; preserve production volumes and earlier
   migration checkpoints and proofs.

The strict `scripts/cluster-upgrades/storage-csi-acceptance.sh` helper also counts
retained failed migration Pods as consumers. If those historical Pods are the
only reported failures, preserve them and record their exact UIDs, terminal
states, lack of running containers, and the newer successful native proof that
supersedes them. Record the helper's failed result and the separate active
consumer verification. An unready active consumer or a Ceph security warning
still blocks acceptance.

## Recovery

If a new controller cannot provision or expand the isolated canary, stop
acceptance and inspect its events and logs. Revert the two desired-state image
entries through reviewed GitOps to provisioner 6.2.0 and resizer 2.1.0. The CSI
driver and node plugin versions remain fixed, and reverting controllers does
not require reverting or deleting application volumes. Never force-delete a
Pod, PVC, PV, or VolumeAttachment to clear an upgrade symptom.

## Published artifact ceiling

At the release cutoff of 2026-09-10 12:00 UTC, the official release notes for
attacher 4.13.0 and registrar 2.18.0 still list their containers as pending. Their
registry tags return `MANIFEST_UNKNOWN`; the published stable images remain
attacher 4.12.0 and registrar 2.17.0. Retain those working versions until the
official images are published. Do not replace them with staging images.

- [Provisioner 6.3.0 release](https://github.com/kubernetes-csi/external-provisioner/releases/tag/v6.3.0)
- [Resizer 2.2.1 release](https://github.com/kubernetes-csi/external-resizer/releases/tag/v2.2.1)
- [Attacher 4.13.0 release](https://github.com/kubernetes-csi/external-attacher/releases/tag/v4.13.0)
- [Registrar 2.18.0 release](https://github.com/kubernetes-csi/node-driver-registrar/releases/tag/v2.18.0)

## Image configuration reload

The first image-only sync applied successfully, but the controller Deployments
kept their old images. This was reproduced with the live v1.0.4 operator: the
image ConfigMap had the new digests while neither Driver was reconciled.

The [v1.0.4 controller source](https://github.com/ceph/ceph-csi-operator/blob/v1.0.4/internal/controller/driver_controller.go)
watches all Driver updates. It does not watch updates to the referenced image
ConfigMap. Its ConfigMap ownership watch only handles deletion of the separate
CSI configuration map. A Ready Argo ConfigMap therefore does not establish that
new controller images are running.

The Rook Kustomization now copies `data.provisioner` and `data.resizer` from the
rendered image ConfigMap into Driver annotations. This keeps the Helm values as
the only image authority and makes subsequent changes to either sidecar enqueue
normal reconciliation. The annotations are on Driver metadata; they do not
change node Pod templates or require an operator restart. Before accepting this
fix, require both actual controller sidecar versions, unchanged CSI node Pod UIDs,
and the fresh provisioning/expansion canaries described above.
