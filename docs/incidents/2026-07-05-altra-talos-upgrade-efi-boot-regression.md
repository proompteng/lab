# Incident Report: Altra Talos Upgrade EFI Boot Regression

- **Date**: 2026-07-05 UTC
- **Detected by**: Altra BMC/iKVM console, Talos boot logs, Kubernetes node status
- **Reported by**: gregkonush
- **Primary node affected**: `talos-192-168-1-85` / `100.100.244.142` (`altra`)
- **Services affected**: Workloads scheduled on Altra, Rook Ceph OSDs on Altra, Altra GPU workloads
- **Contributing infrastructure**: Talos EFI System Partition, Talos Image Factory installer ISO, BMC/iKVM, Rook Ceph
- **Severity**: Critical for Altra availability; cluster-wide risk while the node remained drained and Ceph OSDs were down
- **Status at write time**: Talos, Kubernetes, GPU, and Ceph recovery completed

## Impact Summary

The Altra Talos `v1.13.5` upgrade attempt left the node booting into an installer-style Talos UKI instead of a normal
installed-system UKI. The node reached the Talos local console with network connectivity, but Talos stayed in `Booting`
and did not bring up Kubernetes or the Talos API because the booted UKI included `talos.halt_if_installed`.

The visible console message was:

```text
Talos is already installed to disk but booted from another media and talos.halt_if_installed kernel parameter is set.
Please reboot from the disk.
```

The data disks were not wiped by this failure. The dangerous change was limited to EFI boot files on the safe Altra
install disk's ESP, `/dev/nvme0n1p1`. The unsafe Ceph DB/WAL disk, `/dev/nvme1n1`, was not selected as the Talos install
disk in the upgrade patch and was not intentionally modified during the EFI recovery attempt.

Because the node had already been cordoned and drained for the planned upgrade, Altra remained
`NotReady,SchedulingDisabled` until boot recovery and post-boot restoration could be completed.

## Root Cause

The root cause was using the wrong Talos boot artifact for a manual ESP UKI replacement path. An ISO-derived
`metal-arm64-secureboot` UKI was copied onto the installed disk's EFI System Partition under both active Talos UKI names:

```text
EFI/Linux/Talos-v1.12.4.efi
EFI/Linux/Talos-v1.13.5.efi
```

That ISO UKI is an installer/boot-media artifact and includes `talos.halt_if_installed`. When firmware booted it from the
installed disk, Talos detected an existing install and halted instead of continuing into the installed system.

The evidence file for the ESP write is:

```text
/tmp/altra-talos-v1.13.5-20260705T072454Z/esp-uki-swap.txt
```

It shows the pre-change active UKIs, backup creation, and replacement hashes:

```text
Talos-v1.12.4.efi -> Talos-v1.12.4.efi.bak.20260705T075518Z
Talos-v1.13.5.efi -> Talos-v1.13.5.efi.bak.20260705T075518Z
```

The copied ISO-derived UKI hash after the replacement was the same for both active files:

```text
ad39dc77dd75728a5c1eb796cc9d824d64e036acf974200bd1a8ec0184a1efea
```

The fallback bootloader file was observed but not overwritten:

```text
EFI/boot/BOOTAA64.efi
```

## Five Whys

1. **Why did Altra fail to return to Kubernetes after the upgrade attempt?**

   It booted into a Talos UKI that halted after detecting Talos was already installed.

2. **Why did the booted UKI halt?**

   The UKI included the installer-media kernel parameter `talos.halt_if_installed`.

3. **Why was an installer UKI present on the installed disk's ESP?**

   A manual ESP UKI replacement copied `Talos-v1.13.5.efi` extracted from the Talos Image Factory secureboot ISO onto the
   installed ESP.

4. **Why was the manual ESP path used instead of a completed normal upgrade path?**

   The `talosctl upgrade` path failed before completing reliably, including a gRPC `ENHANCE_YOUR_CALM`/`too_many_pings`
   failure and a confusing post-reboot state where the node remained on `v1.12.4`.

5. **Why did the manual ESP path not catch the bad artifact before reboot?**

   The process validated file presence and hashes but did not inspect the UKI kernel command line or otherwise verify
   that the artifact was an installed-system boot asset rather than an installer-media boot asset.

6. **Why was this risky path available during a production control-plane upgrade?**

   Existing local documentation described an ARM ESP UKI swap as a workaround for ARM firmware/efivar upgrade failures
   without an explicit prohibition against using installer ISO UKIs, without a command-line inspection gate, and without
   requiring a proven rollback boot test before rebooting a drained control-plane node.

**Actionable root cause**: the upgrade runbook allowed a manual ESP UKI replacement path without artifact provenance and
kernel-command-line validation, and that path was executed against a production control-plane node.

## Contributing Factors

- Altra is both a control-plane node and a storage/GPU workload node, so a failed reboot creates broader blast radius.
- The node was already drained, which intentionally took Altra OSDs and singleton workloads offline for maintenance.
- The live machine config originally had stale `machine.install.disk: /dev/nvme1n1`, requiring a careful correction to
  `/dev/nvme0n1` before upgrade.
- The `talosctl upgrade` command path did not complete cleanly, creating pressure to use the ARM ESP workaround.
- The local ESP workaround documentation did not distinguish installed-system UKIs from installer ISO UKIs.
- Two Talos versions on the ESP and systemd-boot menu were confusing during recovery, even though current/previous Talos
  entries are normal for Talos rollback.
- Final post-recovery verification was delayed because operator console intervention was required through BMC/iKVM.

## What Was Not The Root Cause

- No evidence showed that `/dev/nvme1n1`, the Ceph DB/WAL disk, was selected or wiped by the Talos install path.
- The issue was not caused by Ceph itself; Ceph degradation was a consequence of draining/rebooting the Altra OSD host.
- The BMC fan and voltage sensor alerts were not the boot blocker.
- The existence of both `v1.13.5` and `v1.12.4` Talos boot entries was not itself a failure; Talos keeps current and
  previous boot assets for fallback/rollback.
- Kubernetes `NotReady,SchedulingDisabled` was a symptom of the node being drained and unable to complete boot, not the
  cause of the boot halt.

## Recovery Actions

### Completed before the EFI regression

1. Created an evidence directory:

```bash
EVIDENCE_DIR=/tmp/altra-talos-v1.13.5-20260705T072454Z
```

2. Captured node, Talos, etcd, Ceph, Argo, PDB, disk, volume, and GPU preflight evidence.
3. Verified Altra's safe Talos install disk was `/dev/nvme0n1`; treated `/dev/nvme1n1` as unsafe because it backs Ceph
   DB/WAL.
4. Patched Altra machine config to use `/dev/nvme0n1` and the generated `v1.13.5` Image Factory installer.
5. Saved temporary maintenance objects and paused relevant Argo automation for live PDB/operator patches.
6. Cordon/drain completed without using `--force`, `--disable-eviction`, or manual pod deletion.
7. Captured an etcd snapshot from Turin:

```text
/tmp/altra-talos-v1.13.5-20260705T072454Z/galactic-etcd-before-altra-v1.13.5.db
```

### Bad action

The following unsafe operation caused the boot regression:

1. Extracted `EFI/Linux/Talos-v1.13.5.efi` from the Talos Image Factory `metal-arm64-secureboot` ISO.
2. Mounted the installed ESP from a privileged Kubernetes helper pod on Altra.
3. Backed up the active UKIs.
4. Copied the ISO-derived UKI over both active Talos UKI names.
5. Rebooted the node.

The mistake was not the backup creation; the mistake was treating the ISO-derived UKI as a valid installed-system UKI.

### Manual EFI recovery path

Recovery uses UEFI Shell through BMC/iKVM to restore the pre-change ESP backups:

```text
fs0:
ls EFI\Linux
cp EFI\Linux\Talos-v1.12.4.efi.bak.20260705T075518Z EFI\Linux\Talos-v1.12.4.efi
cp EFI\Linux\Talos-v1.13.5.efi.bak.20260705T075518Z EFI\Linux\Talos-v1.13.5.efi
reset
```

If `fs0:` does not contain `EFI\Linux`, use `map -r` and try `fs1:`, `fs2:`, etc. until the ESP with the Talos files is
found.

After `reset`, boot a plain Talos entry only:

```text
Talos (v1.13.5)
```

or the previous fallback:

```text
Talos (v1.12.4)
```

Do not choose any entry containing:

```text
Reset to maintenance mode
Reset system disk
```

## Final Verification

Final verification is not complete until all checks below pass from a normal workstation shell:

```bash
talosctl -n 100.100.244.142 -e 100.100.244.142 version
talosctl -n 100.100.244.142 -e 100.100.244.142 get machinestatus -o yaml
kubectl --context galactic-lan get node talos-192-168-1-85 -o wide
kubectl --context galactic-lan get --raw='/readyz?verbose'
talosctl -n 100.100.244.190 -e 100.100.244.190 etcd members
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Required final state:

- Altra boots without `talos.halt_if_installed`.
- Talos API on `100.100.244.142:50000` answers.
- `MachineStatus` is `stage=running` and `ready=true`.
- Kubernetes node `talos-192-168-1-85` is `Ready`.
- Altra is uncordoned only after Talos, Kubernetes, etcd, and Ceph are stable.
- Etcd still has three non-learner voters.
- Ceph has no new OSD/PG regression after Altra OSDs return.
- Temporary PDB/operator and Argo automation patches are restored from saved evidence.
- Altra GPU capacity is validated before declaring GPU workload enablement complete.

Observed after EFI recovery on 2026-07-05:

- Talos API answered on `100.100.244.142`.
- Altra reported Talos `v1.13.5`, kernel `6.18.36-talos`, containerd `2.2.5`.
- `MachineStatus` reported `stage=running` and `ready=true`.
- Kubernetes node `talos-192-168-1-85` reported `Ready` and was uncordoned.
- API `/readyz?verbose` passed.
- Etcd still had three non-learner voters.
- Rook mon quorum returned to `e,i,k`.
- Rook OSDs `0-5` were all `up` and `in`.
- The temporary PDB/operator/Argo maintenance patches were restored.
- Altra advertised `nvidia.com/gpu` capacity and allocatable as `1`.
- A real GPU pod scheduled on Altra with `nvidia.com/gpu: 1` and completed `nvidia-smi -L`:

```text
GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-47cb31bc-9007-063d-144e-6a80da6d9e3a)
```

Ceph returned to `HEALTH_OK` with `6/6` OSDs up/in and `409` PGs `active+clean`.

## Direct Live Changes

These live changes were made during recovery and then persisted into repo documentation/manifests:

1. Restored ESP backups from UEFI Shell:

```text
cp EFI\Linux\Talos-v1.12.4.efi.bak.20260705T075518Z EFI\Linux\Talos-v1.12.4.efi
cp EFI\Linux\Talos-v1.13.5.efi.bak.20260705T075518Z EFI\Linux\Talos-v1.13.5.efi
```

2. Uncordoned Altra after Talos returned so Rook mon `e`, OSDs `3/4/5`, and standby MDS could schedule.
3. Restored temporary maintenance patches for TigerBeetle, Forgejo runner, Knative Eventing, Temporal, Torghut TA sim,
   and Argo automation.
4. Enabled Altra GPU containers by removing the VM passthrough workload label and adding:

```text
platform.proompteng.ai/altra-gpu-container-ready=true
```

5. Persisted the Altra container-ready node label in Talos machine config with:

```bash
talosctl patch machineconfig -n 100.100.244.142 -e 100.100.244.142 \
  --patch @devices/altra/manifests/node-labels.patch.yaml \
  --mode=no-reboot
```

6. Created/applied the repo-owned `altra-nvidia-device-plugin` resources in `gpu-operator`.
7. Removed the invalid Altra device-plugin time-slicing config. `replicas: 1` is rejected by NVIDIA device-plugin
   `v0.19.x`; the durable ConfigMap is now plain `version: v1`.

## Post-Boot Restoration Checklist

After Altra boots normally, restore the maintenance posture from saved evidence:

```bash
CTX=galactic-lan
EVIDENCE_DIR=/tmp/altra-talos-v1.13.5-20260705T072454Z

kubectl --context "$CTX" -n torghut apply -f "$EVIDENCE_DIR/torghut-tigerbeetlecluster.before-maintenance.yaml"
kubectl --context "$CTX" -n forgejo-runners apply -f "$EVIDENCE_DIR/forgejo-runners-arm64-pdb.before.yaml"
kubectl --context "$CTX" -n knative-eventing apply -f "$EVIDENCE_DIR/knativeeventing.before-maintenance.yaml"
kubectl --context "$CTX" -n temporal apply -f "$EVIDENCE_DIR/temporal-elasticsearch-master-pdb.before-maintenance.yaml"
kubectl --context "$CTX" -n torghut apply -f "$EVIDENCE_DIR/torghut-ta-sim-pdb.before-maintenance.yaml"

kubectl --context "$CTX" -n argocd apply -f "$EVIDENCE_DIR/applicationset-product.before-maintenance.yaml"
kubectl --context "$CTX" -n argocd apply -f "$EVIDENCE_DIR/applicationset-platform.before-maintenance.yaml"
kubectl --context "$CTX" -n argocd apply -f "$EVIDENCE_DIR/argocd-torghut.before-maintenance.yaml"
kubectl --context "$CTX" -n argocd apply -f "$EVIDENCE_DIR/argocd-knative-eventing.before-maintenance.yaml"
```

Only after health checks pass:

```bash
kubectl --context "$CTX" uncordon talos-192-168-1-85
```

## Follow-Up Actions

1. Remove or rewrite the ARM ESP UKI swap guidance in `devices/galactic/docs/tailscale.md`. It must not recommend
   replacing installed-system UKIs with ISO-derived installer UKIs.
2. Add a hard gate to any Talos ARM ESP procedure: inspect the UKI command line and fail if it contains
   `talos.halt_if_installed`, `talos.platform=metal`, or other installer-media-only arguments.
3. Prefer `talosctl upgrade` and `talosctl rollback` for production Talos upgrades. Manual ESP surgery should be a
   break-glass recovery procedure, not an upgrade implementation path.
4. Add a production upgrade rule: do not perform a manual ESP write on a drained control-plane/storage node unless a
   tested BMC/UEFI rollback path and exact backup filenames are written down first.
5. Update `docs/runbooks/talos-latest-upgrade-plan.md` to include this incident as a prohibited path and to require
   explicit post-upgrade restoration of PDB/operator/Argo patches.
6. Keep old and new Talos boot entries documented as normal, but make reset/maintenance entries explicitly forbidden
   during recovery unless intentionally wiping or reinstalling the node.
7. Re-run the Altra Talos upgrade only after the node is healthy, Ceph is stable, maintenance patches are restored, and
   a corrected upgrade path is reviewed.

## Related Documents

- [Talos Latest Upgrade Plan](../runbooks/talos-latest-upgrade-plan.md)
- [Rook Ceph On Talos](../runbooks/rook-ceph-on-talos.md)
- [Altra Volume Relayout, Etcd Member Recovery, And Node Rejoin](2026-02-18-altra-volume-relayout-etcd-rejoin.md)
- [Kafka User Reconciliation Failure From Ceph Recovery Pressure](2026-07-03-kafka-user-reconciliation-ceph-recovery-pressure.md)
