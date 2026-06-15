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
talosctl --insecure -n 100.100.244.171 -e 100.100.244.171 get disks -o yaml
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

The installer-image patch is generated from
`devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml`, which includes
the Tailscale system extension plus the NVIDIA LTS kernel module and container
toolkit extensions. Do not use deprecated `machine.install.extensions` fields
for Turin.

Generate the gitignored service config with:

```bash
bun run packages/scripts/src/tailscale/generate-turin-extension-service.ts
```

Then include these patches with the first `talosctl apply-config`:

```bash
--config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
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
talosctl -n <turin-node-ip> -e <endpoint> service ext-tailscale status
talosctl -n <turin-node-ip> -e <endpoint> logs ext-tailscale | tail -n 40
talosctl image pull -n <turin-node-ip> -e <endpoint> registry.ide-newton.ts.net/lab/registry-smoketest:<tag>
```

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
- After reseating the PCIe carrier connections, Talos maintenance mode enumerates
  four NVMe disks/controllers:
  - `/dev/nvme0n1`: Transcend `TS256GMTE652T2`, serial `I203860329`, 256GB
  - `/dev/nvme1n1`: Intel `SSDPEKKF256G8L`, serial `BTHH851313AU256B`, 256GB
  - `/dev/nvme2n1`: Kingston `SNV3S1000G`, serial `50026B76878F0B27`, 1.0TB
  - `/dev/nvme3n1`: `ORICO`, serial `13CBMEK6HEW8CN2X9AKW`, 4.1TB
- Talos install target:
  `/dev/disk/by-id/nvme-ORICO_13CBMEK6HEW8CN2X9AKW`, currently visible as
  `/dev/nvme3n1`.
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
talosctl --insecure -n 100.100.244.171 -e 100.100.244.171 get disks -o yaml
```

For a clean Turin install, apply the generated amd64 machine config with the
Turin install patch:

```bash
talosctl apply-config --insecure -n 100.100.244.171 -e 100.100.244.171 \
  -f devices/turin/controlplane.yaml \
  --config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
  --config-patch @devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml \
  --config-patch @devices/turin/manifests/hostname.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --config-patch @devices/turin/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/turin/manifests/tailscale-dns.patch.yaml \
  --mode=reboot
```

Do not pass any HDD path in `--user-disks-to-wipe`, and do not enable
`useAllDevices` in Rook.

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
