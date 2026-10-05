# Temporal

This Application owns Temporal's frontend, history, matching, and system worker, plus its retained persistence upgrade
resources. Helm chart 1.6.0 provides the server and UI manifests. The reviewed image pins remain in `kustomization.yaml`.

The system worker's CPU and memory reporting is built by
[services/temporal-worker](../../../services/temporal-worker/README.md). The Kustomize worker patch gives only that
Deployment its own Kustomize image name. Kargo's `temporal-worker` Stage updates that image entry on
`kargo/temporal-worker`; all other server components keep the upstream Temporal image.

Normal releases follow the [Kargo delivery contract](../../../docs/release-automation.md). Resource reporting is
accepted only after the new pod's exact image and current SDK heartbeat are verified and its worker UI no longer
shows the dependency warning. The worker restart creates a new worker instance key.

Do not re-run retained upgrade Jobs or prune persistence resources to enable resource reporting. Limit any authorized
manual synchronization to the exact promoted revision and affected worker Deployment after reviewing its live diff.

## Cassandra capacity

`cassandra-pvcs.yaml` declares the three existing `data-temporal-cassandra-{0,1,2}` claims at 30Gi. They were expanded
online from 20Gi on 2026-10-04 using the existing Rook RBD/ext4 volumes. Each PVC and PV reached 30Gi, each mounted
filesystem expanded, and the original pods remained Ready without a restart. All three Cassandra nodes were Up/Normal,
with no pending or aborted compactions, and Temporal cluster health returned `SERVING` after expansion.

The manifests retain the existing claim names, storage class, access mode, and volume mode. They intentionally omit
controller-owned `volumeName`, status, finalizers, and owner references. Server-side apply adopts the existing claims;
it must preserve their UIDs and bound PVs. `Prune=false,Delete=false` protects them from Argo pruning and Application
deletion. Do not add `Force`/`Replace`, delete/recreate claims, or edit PV capacity to perform a resize.

The Cassandra Helm `persistence.size` remains **20Gi** because it renders the live StatefulSet's immutable
`volumeClaimTemplates`. This is an existing-claim capacity change, not a completed template migration. The three
explicit claims retain 30Gi across normal pod replacement. Before scaling beyond three replicas, declare and validate
the additional ordinal claims at the intended capacity, or plan a separately authorized, data-preserving StatefulSet
template migration. Do not simply change the Helm size or force-recreate the StatefulSet.

### Delivery and verification

Use the normal reviewed `main` change, Temporal-worker image build, Kargo `temporal-worker` promotion, and Argo
reconciliation of `argocd/applications/temporal` on `kargo/temporal-worker`. Do not edit the generated branch or re-run
retained upgrade Jobs. A merged source change is not evidence that Argo has adopted the claims: verify the promoted
revision and each claim's Temporal tracking annotation after reconciliation.

Before applying a capacity change, verify the exact claim UIDs/PV bindings, available Ceph pool capacity, StorageClass
expansion support, and all three Cassandra nodes' readiness. Validate the rendered manifests and use a server-side
dry run against the existing PVCs. Resize one existing claim at a time, beginning with the least headroom, and wait for
PVC/PV capacity, the mounted filesystem, and cleared resize conditions before proceeding. Preserve the original pod
UIDs/restart counts; check `nodetool status`, `nodetool compactionstats`, and Temporal cluster health afterward.

Expansion cannot be rolled back by shrinking to 20Gi. If a resize stalls, inspect PVC events, CSI controller/node
status, and Ceph health; do not treat a restart, claim deletion, or smaller capacity as an automatic recovery step.
Keep the declared request at least as large as the expanded capacity, including when reverting unrelated changes.

References: [Kubernetes PVC expansion](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#expanding-persistent-volumes-claims),
[Rook 1.20 expansion prerequisites](https://rook.io/docs/rook/v1.20/Storage-Configuration/Ceph-CSI/ceph-csi-drivers/#dynamically-expand-volume),
and [Argo retention options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/).
