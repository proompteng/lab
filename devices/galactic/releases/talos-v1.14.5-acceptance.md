# Talos 1.14.5 acceptance, 2026-11-01

All three hosts booted Talos `v1.14.5`, Linux `6.18.58-talos`, containerd `2.3.7` and etcd `3.7.3`.
Kubernetes remains `v1.37.0`. Node UIDs, system UUIDs and PodCIDRs match the pre-upgrade inventory.

| Host  | Architecture | GPU allocatable | Kata guest and host proofs                             |
| ----- | ------------ | --------------- | ------------------------------------------------------ |
| Ryzen | amd64        | AMD: 1          | QEMU, Cloud Hypervisor, Firecracker, Dragonball passed |
| Turin | amd64        | NVIDIA: 8       | QEMU, Cloud Hypervisor, Firecracker, Dragonball passed |
| Altra | arm64        | NVIDIA: 1       | QEMU, Cloud Hypervisor, Firecracker, Dragonball passed |

The [installer receipt](talos-v1.14.5.json) records the immutable per-architecture manifests, schematics,
signed extension catalog and unchanged Kata r6 artifact. All three `verify-installer.sh` gates passed before
installation. The existing runtime verifier supplied all twelve guest and host proofs and removed its temporary
Pods and bootstrap Secrets. The [release procedure](README.md#talos-1145-patch-upgrade) owns future execution.

## Boot and device identity

Ryzen's persistent EFI default points to `Talos-v1.14.5.efi`. After the handoff repair below, Turin's default is
`Talos-v1.14.5~1.efi`, containing the same verified 1.14.5 installer payload.
Altra's installer wrote the new UKI and bootloader, then failed only at the documented ADLINK
`LoaderEntryDefault` EFI-variable write with `input/output error`. Its selected filename remains
`Talos-v1.12.4.efi`; that filename now contains the verified 1.14.5 payload.

The ARM64 UKI was streamed from the immutable installer manifest and independently compared with the staged file:

```text
usr/install/arm64/vmlinuz.efi
590874112 bytes
sha256:6eead93a90dd26767c58d2859fbd4cc940e10cb8846c07886016b5d795ae714f
```

On system-disk serial `2441E98EAAFB`, the staged file atomically replaced the payload at the existing selected
filename. Its hash was checked again after filesystem sync, and the EFI filesystem was unmounted before reboot.
No new backup, parallel OS copy, recovery Pod or privilege grant was created. Platform and NIC firmware were unchanged.

Altra's NVMe enumeration reversed on reboot. System serial `2441E98EAAFB` is now `/dev/nvme0n1`; Ceph database
serial `2402E88D0863` is `/dev/nvme1n1`. The Omni install selector uses the system serial. Its resolved status and
effective Talos install path both matched `/dev/nvme0n1` after the final template handoff. Never reuse the
pre-reboot device number for an installer or filesystem operation.

## Omni handoff race

Updating the Cluster target to 1.14.5 and removing its lock in one resource update did not atomically update
Omni's derived install targets. Server logs show a Turin upgrade request for `1.14.0` and the corresponding
`:v1.14.0` installer after the handoff. Its persistent EFI default changed to `Talos-v1.14.0~2.efi`, while its live
kernel remained 1.14.5. The automatic drain evicted Turin's three OSD Pods and all six replacement slot Pods.
It timed out after five minutes, before rebooting, on PDB-blocked services. No host boot ID changed.

The [Omni 1.11.0 installed-image check](https://github.com/siderolabs/omni/blob/v1.11.0/internal/backend/runtime/omni/controllers/omni/machineconfig/status.go#L863-L911)
compares the live host against its derived install target. A stale older target can therefore trigger a downgrade
of a manually pre-upgraded host. A matching Cluster target and an up-to-date `MachineUpgradeStatus` alone did not
prove safe adoption.

Recovery restored the cluster lock at the already-selected 1.14.5 target. The controller subsequently reported
all three applied configurations at 1.14.5, with no errors or pending reboot markers. Turin's exact verified 1.14.5
installer was restaged with reboot and drain disabled, restoring its persistent boot selection without another
node reboot. All derived `MachineConfigGenOptions` install targets were independently checked at 1.14.5.
The evicted OSDs were restored on Turin, and its slot homes required another fenced binding repair.
This repairs the current rollout; it does not fix the upstream handoff race or justify repeating that procedure.

The final dry run removed only the cluster lock after desired, derived, applied and live versions all matched
1.14.5. The lock-only sync completed. A subsequent audit confirmed all three machines up to date, no config errors
or pending reboot markers, and the cluster unlocked at Talos 1.14.5 / Kubernetes 1.37.0. All three nodes remained
Ready and schedulable with unchanged post-upgrade boot IDs and the correct persistent EFI selections above.

## Storage and database observations

Turin returned with two active Ceph LVs missing their device nodes. Targeted `vgmknodes`, restored existing Ceph
ownership and normal replacement of the failed OSD Pod restored all six OSDs. No OSD disk was formatted or replaced.
Nine RBD PGs then required approximately 983 GB of full backfill from Altra. Altra stayed online until all 601 PGs
were clean, six OSDs were up/in and all three monitors were in quorum. Its subsequent client drain excluded OSDs,
so they remained available while databases flushed and unmounted.

A 120-second ephemeral `high_recovery_ops` trial did not materially improve recovery. All six OSDs returned to
`high_client_ops`, verified against their original effective settings. `osd_max_scrubs=3`, recovery concurrency,
backfill concurrency, pool replicas, storage classes and durability settings were unchanged.
After the extra handoff drain, all 601 PGs recovered to clean, all six OSDs were up/in and all three monitors were
in quorum. CephFS had an active MDS and a standby-replay MDS. The final audit still reported BlueStore slow
operations, overdue deep scrubs and a recent daemon crash; those warnings were not muted or declared fixed.
The final effective settings matched the baseline on all six OSDs, with the client-priority profile inherited
from the monitor configuration and no remaining runtime override from the trial.

All fifteen PostgreSQL primary SQL probes passed after Altra returned. Each reported `wal_buffers=16MB`,
`fsync=on`, `full_page_writes=on` and `synchronous_commit=on`, matching the baseline. On each storage host, a Buzz
instance's PostgreSQL process shut down cleanly but its CNPG manager hung. The manager was stopped only after
confirming the clean database shutdown and zombie-only PostgreSQL process state. No Pod was force-deleted.

## Workspace impact and authenticated acceptance

Turin's graceful shutdown terminated six standalone Tengri slot Pods and a standalone performance-test Pod.
Extended `NoExecute` tolerations and drain exclusions did not preserve the slot-local VM snapshots. The original
workspace snapshot was lost; this must not be described as a successful snapshot restore.

Fenced recovery verified the old writer had stopped and the volumes had detached. It retained the original
MicroVM, Lease, home PVC, owner grant, guest image and active-run pin while the controller created a replacement
slot Pod. The original workspace reached `Sleeping` / `GuestNotStarted` with its retained home. The performance-test
Pod was left terminal rather than restarted as part of production recovery.

The current Restate worker revision was Ready at 2/2. Two replacement Pods for a retained older revision could not
start because its hashed release ConfigMap had been pruned by an application promotion. That revision still owned
one paused durable invocation. Its exact ConfigMap was regenerated from Kargo commit
`d536143ae1167134e720af573baf194f37748b2a`, with the generated name verified as `tengri-release-2795m5mdt2`.
The restored immutable ConfigMap belongs to that existing ReplicaSet so normal garbage collection removes it
when the revision retires. No invocation was reset, resumed or reassigned. This restores the missing dependency;
both retained worker Pods became Running and Ready. It does not fix retention of dependencies across future
application promotions.

The later authenticated check confirmed the original MicroVM Ready, with the same home PVC, guest image and
active-run pin. Its saved power preference remained 60 minutes. The browser refreshed the live Finder listing
and successfully rendered the retained `/workspace/relay-stage-1-implementation.md` through Quick Look.
Existing conversations and their message/tool history remained accessible, including the original pending
input request. No new message, answer, invocation reset or permission grant was submitted for this verification.
The agent connection recovered from `Reconnecting` to `Input requested` after refreshing the workspace.

This completes the retained-home and authenticated-access checks for the rebuilt guest. The original Pod-local
memory snapshot remains lost; the replacement guest's `SnapshotRestored` condition does not establish recovery
of that original snapshot. The separate [post-upgrade NIC and storage observations](../../../docs/incidents/2026-11-01-altra-nic-and-switch-receive-path.md#post-upgrade-verification)
still show receive loss, PCIe errors and material storage latency, so OS acceptance does not mean the performance
incident is fixed.
