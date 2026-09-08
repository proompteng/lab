# Storage upgrade acceptance

This manual Argo Application proves RBD and CephFS writes survive a remount and
RGW supports conditional PUT and readback. It reuses two retained 1 GiB claims in
the existing `rook-ceph` namespace. Successful hook Jobs are removed; failed Jobs
remain for inspection.

Before syncing a reviewed revision, use context `galactic-lan` to verify all Ceph
daemons use the intended version, all six OSDs are up/in, PGs are active and clean,
and both CSI node DaemonSets have completed their intended image rollout. Verify
CSI key generation and existing workload mounts before creating these test Pods.

Sync the complete `storage-upgrade-acceptance` Application after those checks;
selecting individual resources skips hooks. RBD/CephFS writers run at PostSync
wave 20, remount readers at wave 21, and the RGW check at wave 22. ReadWriteOncePod
prevents writer and reader Pods from mounting the same claim concurrently. RGW
uses a unique temporary bucket and the existing Loki user without changing its
permissions.

This Application reports functional storage results independently from Ceph's
security health. The strict `scripts/cluster-upgrades/storage-csi-acceptance.sh`
gate still requires `HEALTH_OK`. Legacy CSI encryption warnings on kernels that
cannot support AES256K remain unresolved security findings even when the canary
passes; do not mute them or report this Application as proof they are fixed.
