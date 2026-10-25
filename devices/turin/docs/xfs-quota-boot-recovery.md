# Diagnose Turin's XFS quota boot delay

Use this guide when Turin boots the intended Talos image but CRI waits for `/var` mounts.
For an older image, follow [Restore the Talos boot default](talos-boot-default.md) first.

## Findings from October 10, 2026

Turin ran Talos `v1.14.0` with Linux `6.18.48-talos`. Its ORICO system disk, serial
`13CBMEK6HEW8CN2X9AKW`, contained a roughly 4 TB XFS `EPHEMERAL` volume with 384 allocation groups
and about 39.6 million used inodes. The live volume configuration had `grow: true` and
`projectQuotaSupport: true`.

Talos temporarily mounts XFS without quota options when it grows the filesystem. XFS clears the quota
accounting flags on that mount. The final mount enables project quotas and triggers a full inode recount.
The grow path runs whenever the existing volume has growth enabled, even when it already fills the partition.
See the [Talos growth code](https://github.com/siderolabs/talos/blob/v1.14.0/internal/app/machined/pkg/controllers/block/internal/volumes/format.go)
and [XFS quota flag handling](https://github.com/gregkh/linux/blob/v6.18.48/fs/xfs/xfs_mount.c).

One boot stopped in `xfs_qm_flush_one`, called by `xfs_qm_quotacheck`, with disk I/O counters unchanged
across repeated samples. A later boot completed the quota check in 2 minutes 16 seconds and started CRI,
etcd, and kubelet. The [upstream quota flush-lock fix](https://github.com/torvalds/linux/commit/ffb48dccce1960a9ea24463a2f3c21d124d6b672)
describes a matching failure class. The exact trigger on Turin was not proven. Talos `v1.14.2` retains
the same temporary growth-mount behavior, so an upgrade alone is not a verified fix.

The Kingston Ceph DB disk, serial `50026B76878F0B27`, was absent during an earlier boot and returned
after a power cycle. Its disappearance was a separate blocker for the original OSDs `0`, `1`, and `2`.
The cause of that disappearance was not established. Both the ORICO and Kingston disks reported zero
NVMe media errors. That readback does not exclude intermittent hardware faults.

## Check progress before another restart

Use the direct LAN endpoint while Turin's Tailscale service is restarting:

```bash
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 version
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 services
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 get volumeconfig EPHEMERAL -o yaml
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 get volumestatus EPHEMERAL -o yaml
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 disks
talosctl --context ryzen --endpoints 100.100.244.190 --nodes 100.100.244.190 dmesg |
  rg 'Quotacheck|resetting quota|XFS|nvme.*(timeout|reset)|I/O error'
```

Resolve the current device name from the volume and disk readback. NVMe numbering changes when a disk is missing.
Sample that disk's `/sys/block/<device>/stat` more than once. A volume phase of `ready` alone does not prove
that `/var` mounted. If a quota check started, require `Quotacheck: Done.`. Confirm running CRI, etcd, and kubelet.

If progress stops, capture the blocked kernel task stack through an authorized Talos debug container.
The inode scan waits in `xfs_iwalk_threaded`; the observed flush wait was in `xfs_qm_flush_one`.
Distinguish a scan with increasing reads from a flush wait with unchanged counters before choosing recovery.
Do not repeat power cycles while a scan is progressing or run writable filesystem repair on a mounted volume.

## October 14 recurrence

The same `xfs_qm_flush_one` wait stopped Turin after the Kata r6 maintenance reboot and Kingston enumeration
recovery. Disk counters stopped changing for more than 30 minutes. A staged configuration disabling
`diskQuotaSupport` was accepted, and the persistent resource showed `false` before a chassis power cycle.
That resource readback did not establish which configuration the next boot would load.

The next boot still had `diskQuotaSupport: true` and mounted `/var` with project quotas enabled.
Its quota check completed from `08:34:09Z` to `08:34:59Z`. CRI, etcd, kubelet, and Tailscale then started.
The restart recovered the host; quota disabling was not the applied fix. The reason the staged value did
not become active remains unresolved. Do not use the accepted staging response as proof of persistence.

## Prevent the unnecessary recount

The Turin-only `VolumeConfig` patch in the authoritative
[Omni template](../../galactic/omni/cluster-template.yaml):

```yaml
apiVersion: v1alpha1
kind: VolumeConfig
name: EPHEMERAL
provisioning:
  grow: false
```

This disables future automatic growth of the existing expanded volume and keeps project quotas enabled.
It does not repair quota metadata or prove that the kernel flush-lock bug is fixed.
Render, validate, and review the patch through the [Omni workflow](../../galactic/omni/README.md) before applying it.
Verify a later boot without the temporary growth mount or another quota recount before calling prevention complete.

## Verify Ceph recovery and restore its profile

After the successful boot, all six original OSDs returned up and in, all three monitors joined quorum,
and all 601 PGs became active. Recovery continued with degraded PGs and existing scrub and BlueStore warnings.
These were incident observations, not a claim that the cluster had finished recovery.

The temporary maintenance change was only `osd_mclock_profile=high_recovery_ops`.
Measured capacity overrides and recovery concurrency stayed unchanged because three OSDs already reported
BlueStore slow operations. Do not substitute the aggressive capacity and concurrency surge from the
[performance runbook](../../../docs/runbooks/rook-ceph-client-ops-performance.md).

```bash
kubectl --context galactic-lan -n kube-system get node turin
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph status
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph quorum_status --format json
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get osd osd_mclock_profile
```

Require Turin readiness, the Kingston disk, the original OSD identities, six OSDs up and in, three monitors
in quorum, all PGs active, and recovery progress. Follow the
[storage recovery runbook](../../../docs/runbooks/galactic-storage-and-workload-recovery.md) for acceptance.
Once recovery and backfill finish, restore the Git-owned profile through reviewed GitOps reconciliation.
The direct rollback below requires explicit authorization for this runtime change or an authorized emergency procedure:

```bash
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_profile high_client_ops
for service in client background_recovery background_best_effort; do
  for setting in res wgt lim; do
    kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- \
      ceph config rm osd "osd_mclock_scheduler_${service}_${setting}"
  done
done
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get osd osd_mclock_profile
```

The monitor config store alone does not prove restoration. Read the effective profile and all nine scheduler
values from every running OSD, as required by the
[scrub catch-up procedure](../../../docs/runbooks/rook-ceph-on-talos.md#scrub-catch-up-posture):

```bash
set -euo pipefail
for ceph_osd_id in 0 1 2 3 4 5; do
  kubectl --context galactic-lan -n rook-ceph exec "deploy/rook-ceph-osd-${ceph_osd_id}" -c osd -- \
    env -u CEPH_ARGS ceph daemon "osd.${ceph_osd_id}" config show |
    python3 -c '
import json, sys
config = json.load(sys.stdin)
classes = ("client", "background_recovery", "background_best_effort")
keys = ["osd_mclock_profile"] + [
    f"osd_mclock_scheduler_{group}_{field}"
    for group in classes for field in ("res", "wgt", "lim")
]
print(json.dumps({"osd": sys.argv[1], **{key: config[key] for key in keys}}, indent=2))
' "$ceph_osd_id"
done
```

Require `high_client_ops` and compare all nine effective values with Ceph Tentacle's built-in profile in the
[owning procedure](../../../docs/runbooks/rook-ceph-on-talos.md#scrub-catch-up-posture). The monitor store must not retain
custom scheduler overrides. Confirm all effective values after the last OSD restart before accepting restoration.
Record residual scrub or slow-operation warnings separately. Do not purge or recreate OSDs to clear them.
