# Turin cluster join and Ceph OSD migration plan

Turin is being prepared as a new Talos node for the existing `galactic` cluster.
This file is a plan only; it intentionally does not change live cluster state.

Cluster state from repo docs:

- Talos cluster name: `ryzen`
- Kubernetes contexts: `galactic-lan` and `galactic-tailscale`
- LAN Kubernetes endpoint: `https://100.100.244.141:6443`
- Ready Kubernetes nodes:
  - `talos-192-168-1-194` at `100.100.244.141`
  - `talos-192-168-1-85` at `100.100.244.142`
- Historical three-node control-plane inventory also includes `ampone` as
  `talos-192-168-1-203`; verify live that this is still the replacement lane
  before any GitOps changes.

## No-mutation checks first

Verify the existing cluster and the new host without applying Talos config,
resetting hardware, or changing Rook:

```bash
kubectl --context galactic-lan get nodes -o wide
kubectl --context galactic-lan -n rook-ceph get pods -o wide
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

When Turin is in Talos maintenance mode at `100.100.244.171`, inspect disks:

```bash
talosctl get disks --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml
```

If the generated `devices/turin/talosconfig` does not exist yet, use the existing
operator Talos config and the cluster endpoints from
`docs/runbooks/galactic-kubernetes-access.md`.

## Talos join shape

Turin must reuse the existing cluster secrets, not bootstrap a new cluster.
Do not run `talosctl bootstrap` for this node.

The canonical join flow lives in:

- `devices/galactic/docs/add-control-plane-node.md`

For Turin, the generated files are intentionally gitignored:

- `devices/turin/controlplane.yaml`
- `devices/turin/worker.yaml`
- `devices/turin/talosconfig`
- `devices/turin/node-machineconfig.yaml`

For a clean install to the maintenance-mode NVMe target, apply
`devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml`. That patch
sets `machine.install.disk:
/dev/disk/by-id/nvme-ORICO_13CBMEK6HEW8CN2X9AKW` and
`machine.install.wipe: true`.

Before applying a config, decide whether Turin is joining as:

- a control-plane replacement for the maintenance node, or
- a worker/storage-only node.

For a control-plane replacement, update the load balancer and apiserver SANs in
the same style as the existing device runbooks before applying the new config.
For a worker/storage-only node, do not add it to control-plane load balancer
backends or etcd.

## Tailscale preinstall requirement

Turin needs node-level Tailscale before the first real cluster join. Kubernetes
pulls private images through node `kubelet`/`containerd`, so pod networking is
not enough for `registry.ide-newton.ts.net` image pulls.

Preinstall the required Talos pieces in the machine config:

- Talos Image Factory installer image:
  `devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml`
- `ExtensionServiceConfig` generated from:
  `devices/turin/manifests/tailscale-extension-service.template.yaml`
- Talos DNS patch:
  `devices/turin/manifests/tailscale-dns.patch.yaml`
- NVIDIA kernel module load patch:
  `devices/turin/manifests/nvidia-kernel-modules.patch.yaml`
- Physical underlay MTU patch required for Flannel VXLAN traffic:
  `devices/turin/manifests/network-mtu.patch.yaml`

The installer-image patch is generated from
`devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml`, which includes
the Tailscale system extension plus the NVIDIA open GPU kernel module and
container toolkit LTS extensions. Do not use deprecated
`machine.install.extensions` fields for Turin.

Generate the gitignored service config with:

```bash
bun run packages/scripts/src/tailscale/generate-turin-extension-service.ts
```

Then include these patches with the first `talosctl apply-config`:

```bash
--config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
--config-patch @devices/turin/manifests/nvidia-kernel-modules.patch.yaml \
--config-patch @devices/turin/manifests/network-mtu.patch.yaml \
--config-patch @devices/turin/manifests/tailscale-extension-service.yaml \
--config-patch @devices/turin/manifests/tailscale-dns.patch.yaml
```

Keep `TS_ACCEPT_DNS=false`; Talos should manage nameservers through machine
config. Do not commit the generated
`devices/turin/manifests/tailscale-extension-service.yaml`, because it contains
the Tailscale auth key.

Validate after install/reboot:

```bash
talosctl -n <turin-node-ip> -e <endpoint> get extensions | rg tailscale
talosctl -n <turin-node-ip> -e <endpoint> read /proc/modules | rg '^nvidia'
talosctl -n <turin-node-ip> -e <endpoint> service ext-tailscale status
talosctl -n <turin-node-ip> -e <endpoint> logs ext-tailscale | tail -n 40
talosctl image pull -n <turin-node-ip> -e <endpoint> registry.ide-newton.ts.net/lab/registry-smoketest:<tag>
```

## Post-install validation snapshot

Verified after the Turin install:

- Talos machine status: `stage: running`, `ready: true`, no unmet conditions.
- Talos health: etcd, apid, kubelet, static pods, CoreDNS, kube-proxy, and node
  schedulability checks pass.
- Kubernetes node: `turin`, control-plane, Ready, schedulable, InternalIP
  `100.100.244.171`.
- Etcd members: `.141`, `.142`, and `.171` are all voters; Turin is no longer a
  learner.
- Tailscale extension: running with live tailnet address `100.114.46.58`.
  An older offline Tailscale entry for `turin.ide-newton.ts.net` at
  `100.79.94.63` may still exist; remove that stale tailnet device before
  relying on the short DNS name `turin`.
- Talos system volumes: `STATE` and `EPHEMERAL` are on the ORICO OS disk
  `/dev/nvme1n1` / `/dev/disk/by-id/nvme-ORICO_13CBMEK6HEW8CN2X9AKW`.
- NVIDIA host driver: loaded with `nvidia-open-gpu-kernel-modules-lts`; the host
  sees the RTX PRO 6000 Blackwell GPU.
- Kubernetes GPU scheduling: not enabled yet. The existing GPU Operator values
  intentionally set `devicePlugin.enabled=false`, so `nvidia.com/gpu` is not
  allocatable until a separate GitOps change enables the device plugin for Turin.

## Old 203 removal boundary

The old `talos-192-168-1-203` control-plane/node state must be removed or
reconciled deliberately before Turin becomes the replacement. Treat these as
separate surfaces:

1. Kubernetes `Node` object: delete only if a stale `talos-192-168-1-203`
   object exists and the physical node is permanently gone.
2. Etcd membership: remove the stale `203` member only after confirming the
   remaining control plane has quorum and before reusing that identity.
3. API endpoint/LB/SANs: remove stale `203` backends or SAN expectations, then
   add Turin's final reachable endpoint if it is joining as a control plane.
4. Rook/Ceph host identity: do not delete or purge the Ceph host/OSDs while
   adopting transferred disks. Rook still maps the missing OSDs to
   `talos-192-168-1-203`; preserving or changing that identity is an explicit
   storage decision, not general node cleanup.

Read-only checks before any 203 removal:

```bash
kubectl --context galactic-lan get node talos-192-168-1-203 -o wide
talosctl -n <healthy-control-plane> -e <healthy-control-plane> etcd members
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Do not remove Ceph OSD IDs or purge the old Ceph host as part of Kubernetes/Talos
node cleanup if the goal is to bring those same disks back on Turin.

## Ceph OSD migration posture

Rook-Ceph storage config is explicitly scoped:

- `useAllNodes: false`
- `useAllDevices: false`
- storage nodes are listed in `argocd/applications/rook-ceph/cluster-values.yaml`

That is the correct safety posture for transferred OSD disks.

Configured OSD hosts:

- `talos-192-168-1-85`
- `talos-192-168-1-203`

Do not update `cephClusterSpec.storage.nodes` until these are known:

1. Which old host the transferred disks came from.
2. Turin's final Kubernetes node name after Talos install.
3. Exact `/dev/disk/by-id/*` names for the transferred HDDs and any metadata NVMe.
4. Whether the disks should be adopted as existing OSDs or wiped/recreated.

Disk and OSD safety notes:

- A pre-wipe maintenance readback identified the Kingston 1TB NVMe as
  `/dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27`, which matches the
  Rook `metadataDevice` for `talos-192-168-1-203`.
- Talos dashboard booted from USB reports an installed state volume on
  `/dev/nvme0n1p3` with `talos.halt_if_installed`. This is evidence that the
  transferred NVMe still carries the old node's Talos install/state, not that a
  new Turin install was performed.
- The old `talos-192-168-1-203` lane is documented as `ampone` / arm64, while
  Turin is EPYC / amd64. Do not assume the old Talos bootloader/kernel will boot
  on Turin. Treat the old state detection as proof that the transferred disk is
  visible, not as proof that the old operating system can run on the new CPU
  architecture.
- The expected NVMe topology is 4x M.2 drives on a PCIe carrier card. The
  motherboard M.2 slots are not intended for this build.
- During the maintenance-mode disk check before install, Talos enumerated four
  NVMe disks/controllers:
  - `/dev/nvme0n1`: Transcend `TS256GMTE652T2`, serial `I203860329`, 256GB
  - `/dev/nvme1n1`: Intel `SSDPEKKF256G8L`, serial `BTHH851313AU256B`, 256GB
  - `/dev/nvme2n1`: Kingston `SNV3S1000G`, serial `50026B76878F0B27`, 1.0TB
  - `/dev/nvme3n1`: `ORICO`, serial `13CBMEK6HEW8CN2X9AKW`, 4.1TB
- The post-install disk check showed only three NVMe disks visible: the ORICO
  OS disk plus the Transcend and Intel 256GB devices. The Kingston
  `nvme-KINGSTON_SNV3S1000G_50026B76878F0B27` path was absent.
- Talos install target:
  `/dev/disk/by-id/nvme-ORICO_13CBMEK6HEW8CN2X9AKW`, currently visible as
  `/dev/nvme1n1` after the installed-system reboot.
- BIOS path for bifurcation:
  - `Advanced` -> `CPU Configuration` -> `CPU1 Information`
  - Set the PCIe package group for the physical slot holding the 4x M.2 carrier
    to `x4x4x4x4`.
  - Save changes and reset.
- The H14SSL-N/NT manual says PCIe slots 1, 3, and 5 are x16; slots 2 and 4 are
  x8. A passive 4x M.2 carrier needs an x16 slot for four x4 links.
- Chassis inspection places the 4x M.2 carrier in `PCIE SLOT3` / x16, counted as
  third from the bottom in the chassis. Set `CPU1 PCIe Package Group G2` to
  `x4x4x4x4` for that slot.
- Do not install Talos to the Kingston NVMe when preserving/adopting the
  existing OSDs. Installing Talos there will wipe the Ceph metadata device.
- The 4TB ORICO NVMe is the Talos OS target for this build.

## Clearing old Talos state from the transferred NVMe

The Talos `v1.13.4` amd64 USB image has two GRUB entries:

1. `Talos ISO`
2. `Reset Talos installation`

The second entry adds `talos.experimental.wipe=system`. Use it when the USB
installer stops with `Talos is already installed to disk ... Please reboot from
the disk`. This removes the old Talos install/state marker so the USB can boot
back into normal maintenance mode.

After the reset entry finishes, boot `Talos ISO` again and verify that the API is
available:

```bash
talosctl get disks --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml
```

For a clean Turin install, apply the generated amd64 machine config with the
Turin install patch:

```bash
talosctl apply-config --insecure -n 100.100.244.171 -e 100.100.244.171 \
  -f devices/turin/controlplane.yaml \
  --config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
  --config-patch @devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml \
  --config-patch @devices/turin/manifests/hostname.patch.yaml \
  --config-patch @devices/turin/manifests/etcd-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --config-patch @devices/turin/manifests/network-mtu.patch.yaml \
  --config-patch @devices/turin/manifests/nvidia-kernel-modules.patch.yaml \
  --config-patch @devices/turin/manifests/time-servers.patch.yaml \
  --config-patch @devices/turin/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/turin/manifests/tailscale-dns.patch.yaml \
  --mode=reboot
```

Do not pass any HDD path in `--user-disks-to-wipe`, and do not enable
`useAllDevices` in Rook.

## Ceph OSD adoption or replacement

There are two different paths for the three transferred 24TB OSD disks. Keep
them separate:

1. **Adopt the existing OSDs without data loss.** This requires the external DB
   LVs referenced by the OSD LVM tags. Do not update or sync
   `argocd/applications/rook-ceph/cluster-values.yaml` for Turin on this path
   while the Kingston metadata NVMe is absent.
1. **Forget the old external DB device and recreate OSDs on the three HDDs.**
   This is destructive to the existing OSDs `0`, `1`, and `2`: purge the old
   OSD identities from Ceph, zap the three transferred HDDs, then let Rook
   prepare new OSDs on `turin` without a `metadataDevice`.

Pre-recreate live evidence captured after Talos install:

- Turin sees the three transferred HDDs:
  - `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D`
  - `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M`
  - `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9`
- Before the recreate path was executed, Turin also saw the existing Ceph LVM
  block volumes:
  - `dm-name-ceph--4f30c39a--cd26--427b--9d15--18a15333b1d0-osd--block--63a3b2d6--0d39--436f--a517--4296d04e782c`
  - `dm-name-ceph--af8f93cb--80cc--43fb--9a3b--d927c95534e5-osd--block--834f32e1--93b0--4f79--91ad--5a6771bdf38b`
  - `dm-name-ceph--c04a0830--d083--47fe--8cc9--b25314cd7137-osd--block--6c12f6b3--23dd--4cb1--b482--673f3c160ffc`
- Before the GitOps update, the live Rook `CephCluster` still mapped those HDD IDs and the metadata device
  `/dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27` to
  `talos-192-168-1-203`.
- Existing `rook-ceph-osd-0`, `rook-ceph-osd-1`, and `rook-ceph-osd-2`
  deployments are scaled to zero and still use `ROOK_NODE_NAME` /
  `ROOK_CRUSHMAP_HOSTNAME` `talos-192-168-1-203`.
- Those OSD deployments reference old `ROOK_BLOCK_PATH` values under
  `/dev/ceph-fe2d8c45-670f-4d29-a8a6-a332db785a32/osd-db-*`, which are not
  visible on Turin while the Kingston device is missing.
- A privileged read-only inspection pod on Turin saw the three HDD block LVs as
  OSDs `0`, `1`, and `2`:
  - OSD `0`: `/dev/sdd`, LV
    `/dev/ceph-af8f93cb-80cc-43fb-9a3b-d927c95534e5/osd-block-834f32e1-93b0-4f79-91ad-5a6771bdf38b`
  - OSD `1`: `/dev/sdc`, LV
    `/dev/ceph-4f30c39a-cd26-427b-9d15-18a15333b1d0/osd-block-63a3b2d6-0d39-436f-a517-4296d04e782c`
  - OSD `2`: `/dev/sdb`, LV
    `/dev/ceph-c04a0830-d083-47fe-8cc9-b25314cd7137/osd-block-6c12f6b3-23dd-4cb1-b482-673f3c160ffc`
- `ceph-volume lvm activate --no-systemd --bluestore` failed for all three OSDs
  with missing DB UUID errors:
  - OSD `0`: `could not find db with uuid mkCFn0-dZlx-qwyp-DBpf-hTjy-P8Ox-Ie1uVk`
  - OSD `1`: `could not find db with uuid 5tt84t-fD4F-LEnh-WyqM-AT8r-OZyy-0APfRc`
  - OSD `2`: `could not find db with uuid VTAxqx-egqu-IfU4-VonO-zNiJ-zW2s-2yb2Tb`
- The HDD BlueStore main labels are intact and identify OSD IDs `0`, `1`, and
  `2`, but the LVM tags still require the missing external DB LVs. Do not expect
  Rook to activate those existing OSDs from the HDD block LVs alone.

Safe next check after reseating or reconnecting the missing NVMe:

```bash
talosctl --talosconfig devices/turin/talosconfig \
  -n 100.114.46.58 -e 100.114.46.58 ls /dev/disk/by-id | rg 'KINGSTON|SNV3|50026B76878F0B27|ceph--'
```

Only after the Kingston metadata path and transferred HDDs are all visible should
the non-destructive adoption path move the old storage entry from
`talos-192-168-1-203` to `turin`. Keep the exact HDD IDs and metadata device
path; do not enable `useAllDevices`, and do not purge OSD IDs `0`, `1`, or `2`
when the goal is disk adoption.

If the approved path is to forget the external DB device and recreate the three
24TB OSDs, the safe order is:

The complete execution checklist for this path is in
`devices/turin/docs/ceph-recreate-three-osds.md`. Keep that runbook out of Argo.
The purge/zap steps require explicit destructive approval; that approval was
given before old OSD IDs `0`, `1`, and `2` were purged and the three old
HDD-backed LVM block volumes were zapped on Turin.

1. Confirm Ceph has no inactive or stale PGs:

   ```bash
   kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg dump_stuck inactive
   kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg dump_stuck stale
   ```

1. Purge the old OSD identities only after accepting that old OSDs `0`, `1`,
   and `2` will not be recovered:

   ```bash
   kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 0 --yes-i-really-mean-it
   kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 1 --yes-i-really-mean-it
   kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 2 --yes-i-really-mean-it
   ```

1. Zap the three transferred HDDs on Turin using Rook/Ceph tooling, not Talos
   install flags:

   ```bash
   # OSD 0 old block device
   ceph-volume lvm zap --destroy /dev/ceph-af8f93cb-80cc-43fb-9a3b-d927c95534e5/osd-block-834f32e1-93b0-4f79-91ad-5a6771bdf38b

   # OSD 1 old block device
   ceph-volume lvm zap --destroy /dev/ceph-4f30c39a-cd26-427b-9d15-18a15333b1d0/osd-block-63a3b2d6-0d39-436f-a517-4296d04e782c

   # OSD 2 old block device
   ceph-volume lvm zap --destroy /dev/ceph-c04a0830-d083-47fe-8cc9-b25314cd7137/osd-block-6c12f6b3-23dd-4cb1-b482-673f3c160ffc
   ```

1. Change `argocd/applications/rook-ceph/cluster-values.yaml` so the second
   storage node is `turin`, remove that node's `metadataDevice`, and keep only
   the three exact HDD IDs:

   ```yaml
   - name: turin
     devices:
       - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D
       - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M
       - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9
   ```

1. Sync Rook and watch prepare/OSD creation, then verify `ceph osd tree` shows
   three new up OSDs under host `turin`.

## Post-install `Booting` / etcd learner checks

If Turin appears in Kubernetes but the local Talos dashboard still shows
`Booting`, do not treat that as a stale UI state. Verify Talos readiness and
local etcd health directly:

```bash
talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> get machinestatus -o yaml

talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> service etcd status

talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> logs etcd --tail 120
```

Turin should not be considered joined until `machinestatus.spec.status.ready`
is `true`, `etcd` is healthy, and the member is no longer a learner:

```bash
talosctl -n 100.94.129.1 -e 100.94.129.1 etcd members
```

The LAN uses `100.100.244.128/25`, which sits inside Tailscale's CGNAT range.
For this cluster, etcd and kubelet must still select the LAN address, not the
Tailscale address, so keep these patches in the first apply:

- `devices/turin/manifests/etcd-lan-subnet.patch.yaml`
- `devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml`

If etcd logs show repeated `dial tcp 100.100.244.141:2380: i/o timeout` or
`dial tcp 100.100.244.142:2380: i/o timeout`, prove the LAN path before
rebooting or changing etcd membership:

```bash
nc -vz -G 3 100.100.244.141 2379 2380 6443 50000
nc -vz -G 3 100.100.244.142 2379 2380 6443 50000
nc -vz -G 3 100.100.244.171 2379 2380 6443 50000

ping -c 2 100.100.244.141
ping -c 2 100.100.244.142
ping -c 2 100.100.244.171

tailscale ping -c 3 <turin-tailnet-ip>
```

On Turin, inspect routes, rules, and sockets:

```bash
talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> get routes

talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> get routingrules

talosctl --talosconfig devices/turin/talosconfig \
  -n <turin-tailnet-ip> -e <turin-tailnet-ip> netstat -antp
```

The failure mode observed during Turin bring-up was:

- existing peers `.141` and `.142` were reachable from the workstation;
- Turin was reachable through Tailscale only, with direct Tailscale connectivity
  falling back to DERP;
- the workstation could not ping or open TCP to `100.100.244.171`;
- Turin kept sockets in `SYN_SENT` to `.141/.142:2380`, `.141/.142:6443`, and
  `10.96.0.1:443`;
- packet capture on `eno2np1` showed repeated etcd SYN/SYN-ACK traffic, but the
  connection did not settle.

That evidence points at the physical LAN/switch port profile or NIC path, not a
blind reboot fix. Move Turin to the same non-isolated switch/port profile as the
existing control planes, or fix the LAN policy so bidirectional TCP works between
`100.100.244.171` and `100.100.244.141` / `100.100.244.142` on ports `2379`,
`2380`, `6443`, and `50000`.

If Turin replaces `talos-192-168-1-203` and the same OSD disks are present,
the recovery path uses an amd64 Talos install/config for Turin while preserving
the verified OSD disk IDs. Then sync Rook and watch OSD
prepare/activation. Do not switch `useAllDevices` to true.

Validation after any future approved Rook change:

```bash
kubectl --context galactic-lan -n rook-ceph get pods -o wide
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```
