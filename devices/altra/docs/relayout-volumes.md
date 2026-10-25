# Re-layout Altra (192.168.1.85) Volumes: EPHEMERAL 300GB + Two local-path Volumes

Goal: enforce this exact storage layout on Talos control-plane node `talos-192-168-1-85` (`192.168.1.85`):

- `EPHEMERAL` (`/var`) = `300GB` on `/dev/nvme0n1p4`
- `u-local-path-provisioner` = rest of OS disk on `/dev/nvme0n1p5` mounted at `/var/mnt/local-path-provisioner`
- `u-local-path-provisioner-extra` = extra NVMe (`/dev/nvme1n1p1`) mounted at `/var/mnt/local-path-provisioner-extra`

## Hard Rules

- Keep install disk pinned to `/dev/nvme0n1`.
- Use `disk.dev_path` selectors for this node (`/dev/nvme0n1`, `/dev/nvme1n1`), not WWID selectors.
- Do not run disk wipe jobs in parallel with Talos volume provisioning.
- Keep etcd quorum on the other control-plane nodes (`192.168.1.194`, `192.168.1.203`) throughout the operation.

## Source Manifests

- `devices/altra/manifests/ephemeral-volume.patch.yaml`
- `devices/altra/manifests/local-path.patch.yaml`
- `devices/altra/manifests/local-path-extra.patch.yaml`

`local-path-extra.patch.yaml` must be:

```yaml
apiVersion: v1alpha1
kind: UserVolumeConfig
name: local-path-provisioner-extra
provisioning:
  diskSelector:
    match: disk.dev_path == '/dev/nvme1n1'
  minSize: 100GB
  grow: true
```

## Preflight

```bash
# Disk identity and mapping
 talosctl -n 192.168.1.85 get disks -o yaml

# Confirm etcd on healthy peers before touching 85
 talosctl -n 192.168.1.194 etcd members
 talosctl -n 192.168.1.203 etcd members

# Cordon before disruptive work
 kubectl cordon talos-192-168-1-85
```

Expected disk mapping on this host:

- `/dev/nvme0n1` = OS/install disk
- `/dev/nvme1n1` = extra local-path disk

## Apply Procedure (Maintenance Mode or Normal API)

If node is in maintenance mode:

```bash
talosctl -n 192.168.1.85 apply-config --insecure --mode reboot --file <machineconfig.yaml>
```

If node is already up with Talos API:

```bash
talosctl -n 192.168.1.85 apply-config --mode no-reboot --file <machineconfig.yaml>
```

Where `<machineconfig.yaml>` includes:

- install disk `/dev/nvme0n1`
- `EPHEMERAL` selector `disk.dev_path == '/dev/nvme0n1'` with `minSize=maxSize=300GB`
- `local-path-provisioner` selector `disk.dev_path == '/dev/nvme0n1'`
- `local-path-provisioner-extra` selector `disk.dev_path == '/dev/nvme1n1'`

## Validate Layout

```bash
talosctl -n 192.168.1.85 get volumestatus -o yaml | rg -n 'EPHEMERAL|u-local-path-provisioner|u-local-path-provisioner-extra|phase:|location:|prettySize:'
```

Expected:

- `EPHEMERAL` `ready` at `/dev/nvme0n1p4`, `prettySize: 300 GB`
- `u-local-path-provisioner` `ready` at `/dev/nvme0n1p5`
- `u-local-path-provisioner-extra` `ready` at `/dev/nvme1n1p1`

## Failure Modes and Fixes

### 1) `no disks matched ... have not enough space`

Symptom:

- `u-local-path-provisioner-extra` fails with `1 have not enough space`

Cause:

- Extra volume selector points to OS disk (wrong WWID/disk mapping).

Fix:

```bash
talosctl -n 192.168.1.85 get volumeconfig u-local-path-provisioner-extra -o yaml
# ensure match: disk.dev_path == '/dev/nvme1n1'
```

Reapply machine config with correct selector.

### 2) `no disks matched ... 1 have other issues` + `failed to acquire shared lock`

Symptom:

- `u-local-path-provisioner-extra` fails with `other issues`
- machined logs show `failed to acquire shared lock while probing blockdevice`

Cause:

- A prior wipe job is still writing to `/dev/nvme1n1`.

Detect:

```bash
talosctl -n 192.168.1.85 logs machined | rg 'failed to acquire shared lock|u-local-path-provisioner-extra'
talosctl -n 192.168.1.85 read /proc/diskstats | rg nvme1n1
```

Fix:

- Reboot `85` once to clear stale wipe lock:

```bash
talosctl -n 192.168.1.85 reboot
```

### 3) `error adding member: etcdserver: Peer URLs already exists`

Symptom:

- Node stays `booting`, etcd waits to join repeatedly.

Cause:

- Stale etcd learner/member for `85` already exists.

Fix:

```bash
talosctl -n 192.168.1.194 etcd members
# remove stale member ID for 85 peer URL
talosctl -n 192.168.1.194 etcd remove-member <stale-member-id>
```

Then watch `85` join and promote automatically.

### 4) `apply-config` with `missing kind`

Symptom:

- `error decoding document ... missing kind`

Cause:

- Attempted to reapply raw output of `talosctl get machineconfig -o yaml`.

Fix:

- Apply a proper machine config document (`version: v1alpha1`, `machine`, `cluster`, etc.), not the runtime resource dump.

## Rejoin and Final Health Checks

```bash
# etcd membership should show 3 non-learners
 talosctl -n 192.168.1.194 etcd members

# talos machine ready
 talosctl -n 192.168.1.85 get machinestatus -o yaml | rg -n 'stage:|ready:'

# kubernetes node ready
 kubectl get nodes -o wide

# uncordon when healthy
 kubectl uncordon talos-192-168-1-85
```

## Bootloader Checks (Post-Recovery)

If bootloader instability is suspected, verify active loader metadata (do not blindly delete firmware entries):

```bash
talosctl -n 192.168.1.85 read /sys/firmware/efi/efivars/LoaderEntryDefault-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f | xxd -g 1
talosctl -n 192.168.1.85 read /sys/firmware/efi/efivars/LoaderEntrySelected-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f | xxd -g 1
talosctl -n 192.168.1.85 read /sys/firmware/efi/efivars/LoaderImageIdentifier-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f | xxd -g 1
```

On 2026-02-18, active loader fields pointed to Talos `v1.12.4` and `\\EFI\\BOOT\\BOOTAA64.EFI`.

## Acceptance Criteria

- Volume layout exactly matches target (300GB EPHEMERAL + two local-path volumes on separate devices).
- etcd has 3 healthy voting members.
- `talos-192-168-1-85` is `Ready` and uncordoned.
