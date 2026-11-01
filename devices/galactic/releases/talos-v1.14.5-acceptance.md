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
serial `2402E88D0863` is `/dev/nvme1n1`. The Omni install selector uses the system serial. Require its resolved
status and effective Talos install path to match that serial after the final template handoff. Never reuse the
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

## Storage and database observations

Turin returned with two active Ceph LVs missing their device nodes. Targeted `vgmknodes`, restored existing Ceph
ownership and normal replacement of the failed OSD Pod restored all six OSDs. No OSD disk was formatted or replaced.
Nine RBD PGs then required approximately 983 GB of full backfill from Altra. Altra stayed online until all 601 PGs
were clean, six OSDs were up/in and all three monitors were in quorum. Its subsequent client drain excluded OSDs,
so they remained available while databases flushed and unmounted.

A 120-second ephemeral `high_recovery_ops` trial did not materially improve recovery. All six OSDs returned to
`high_client_ops`, verified against their original effective settings. `osd_max_scrubs=3`, recovery concurrency,
backfill concurrency, pool replicas, storage classes and durability settings were unchanged.

All fifteen PostgreSQL primary SQL probes passed after Altra returned. Each reported `wal_buffers=16MB`,
`fsync=on`, `full_page_writes=on` and `synchronous_commit=on`, matching the baseline. On each storage host, a Buzz
instance's PostgreSQL process shut down cleanly but its CNPG manager hung. The manager was stopped only after
confirming the clean database shutdown and zombie-only PostgreSQL process state. No Pod was force-deleted.

## Workspace impact and remaining acceptance

Turin's graceful shutdown terminated six standalone Tengri slot Pods and a standalone performance-test Pod.
Extended `NoExecute` tolerations and drain exclusions did not preserve the slot-local VM snapshots. The original
workspace snapshot was lost; this must not be described as a successful snapshot restore.

Fenced recovery verified the old writer had stopped and the volumes had detached. It retained the original
MicroVM, Lease, home PVC, owner grant, guest image and active-run pin while the controller created a replacement
slot Pod. The original workspace reached `Sleeping` / `GuestNotStarted` with its retained home. The performance-test
Pod was left terminal rather than restarted as part of production recovery.

The first owner handoff corrected Altra's effective install path to `/dev/nvme0n1`. Remaining gates are recovery
from the extra Turin drain, a lock-only release after all derived targets agree, and authenticated workspace resume
with retained-file and conversation verification. Passkey sign-in requires
the user. These gates remain incomplete until runtime evidence proves them; host readiness alone is insufficient.
