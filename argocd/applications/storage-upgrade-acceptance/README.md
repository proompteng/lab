# Storage upgrade acceptance

Retired from the platform ApplicationSet after the September 2026 upgrades.
These manifests remain as tested reference fixtures; no active Argo application
should deploy them. See the [retirement procedure](../../../docs/runbooks/cluster-stable-upgrades-2026-09.md#retiring-upgrade-test-resources)
for backup preservation and cleanup. Re-enabling them requires a new reviewed rollout.

This manual Argo Application proves RBD and CephFS writes survive a remount and
RGW supports conditional PUT and readback. It reuses two retained 1 GiB claims in
the existing `rook-ceph` namespace. Successful hook Jobs are removed; failed Jobs
remain for inspection.

Before syncing a reviewed revision, use context `galactic-lan` to verify all Ceph
daemons use the intended version, all six OSDs are up/in, PGs are active and clean,
and both CSI node DaemonSets have completed their intended image rollout. Verify
CSI key generation and existing workload mounts before creating these test Pods.

Sync the complete `storage-upgrade-acceptance` Application after those checks;
selecting individual resources skips hooks. The RBD and CephFS writers are pinned
to `talos-192-168-1-194` at PostSync wave 20, and their first remount readers are
pinned to `talos-192-168-1-85` at wave 21. A second fresh RBD and CephFS mount
and readback runs on `turin` at wave 22, alongside the existing RGW check. The
two retained PVCs use ReadWriteOncePod, so each later wave waits for the prior
Pod to finish and release its mount before the next node can mount the claim.
RGW uses a unique temporary bucket and the existing Loki user without changing
its permissions.

The application contains seven PostSync Jobs: the original RBD writer/readback,
CephFS writer/readback, and RGW checks plus the two Turin readbacks. Successful
hooks are removed; failed hooks remain for inspection and block the sync until
they are reviewed.

This Application reports functional storage results independently from Ceph's
security health. The strict `scripts/cluster-upgrades/storage-csi-acceptance.sh`
gate still requires `HEALTH_OK`. Legacy CSI encryption warnings on kernels that
cannot support AES256K remain unresolved security findings even when the canary
passes; do not mute them or report this Application as proof they are fixed.
