# Restore Turin's Talos boot default

Use this procedure when Turin boots an older Talos image from the correct disk. Talos `v1.13.9` rejects the
`trim` field in Turin's newer `UserVolumeConfig` and stops before starting Kubernetes. Keep the current machine
configuration and select the intended image.

Confirm the target version in [`cluster.yaml`](../../galactic/omni/cluster.yaml) and the matching
[release runbook](../../galactic/releases/README.md). The examples below target Talos `v1.14.0`.

## Select the image and save its default

Before any reboot, complete the peer etcd quorum and Ceph preflight in the
[storage recovery runbook](../../../docs/runbooks/galactic-storage-and-workload-recovery.md).
Keep Ryzen and Altra running. Coordinate with the active recovery operator before changing power or boot settings.

1. In Turin's BMC at `100.100.244.170`, confirm host UUID `8bf7ec00-171c-11f1-8000-7cc255f16774`.
2. In BIOS, keep boot mode `UEFI` and select `UEFI OS (ORICO)` as the first hard-disk boot option.
   The system disk is ORICO serial `13CBMEK6HEW8CN2X9AKW`. Leave the other NVMe and Ceph disks unchanged.
3. Open the systemd-boot menu with **Space** during boot and highlight Talos `v1.14.0`.
4. If that entry is not marked as the default, press **d** to save it as the persistent default. Press **Enter** to boot.

Selecting an entry with Enter affects the current boot. The **d** key saves the default in EFI memory.
See the [systemd-boot key bindings](https://systemd.io/BOOT/).

## Verify the running image and persistent default

Query Turin directly. Kubernetes and Omni may still show the version from the last successful connection.

```bash
talosctl --context ryzen --nodes 100.100.244.190 version
talosctl --context ryzen --nodes 100.100.244.190 get bootedentry -o yaml
```

Require server version `v1.14.0` and `bootedEntry: talos-v1.14.0.efi`. Then read both EFI values:

```python
import subprocess

base = ["talosctl", "--context", "ryzen", "--nodes", "100.100.244.190", "read"]
for name in ("LoaderEntrySelected", "LoaderEntryDefault"):
    path = f"/sys/firmware/efi/efivars/{name}-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f"
    raw = subprocess.run(base + [path], check=True, capture_output=True, timeout=15).stdout
    entry = raw[4:].decode("utf-16-le").rstrip("\0")
    print(f"{name}={entry}")
    assert entry == "talos-v1.14.0.efi", f"Unexpected {name}: {entry}"
```

The four-byte prefix contains EFI attributes. Both decoded values must equal `talos-v1.14.0.efi`.
During the October 10 incident, the selected entry was `talos-v1.14.0.efi`, but the saved default was
`Talos-v1.13.9~8.efi`. A successful manual boot alone did not establish that the next cold boot would use 1.14.0.
The reason the old default survived the earlier upgrade was not established.

Complete the storage recovery runbook before declaring Turin recovered. Require the original Kingston metadata disk
at serial `50026B76878F0B27`, the three HDDs, Kubernetes readiness, and the original Ceph OSDs `0`, `1`, and `2` to return.
Do not reset Talos, reinstall, remove `trim`, or delete old boot images to work around a stale default.

If the intended image boots but CRI waits for `/var` mounts, follow
[Diagnose Turin's XFS quota boot delay](xfs-quota-boot-recovery.md).
