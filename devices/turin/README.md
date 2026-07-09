# Turin (Talos node)

This directory tracks the Turin-generation Supermicro tower being prepared as a
new Talos node for the existing `galactic` Kubernetes cluster.

Inventory:

- Device: `turin`
- BMC address: `100.100.244.170`
- Talos maintenance/LAN address: `100.100.244.171/25`
- Board: Supermicro `H14SSL-NT`
- CPU: AMD EPYC Turin `9965`
- Memory: 12x Micron 96GB DDR5 ECC RDIMM, 1152GB total when all sticks are installed
- Cooler: SilverStone `XE360-SP5`
- Expected NVMe: 4x M.2 disks on a PCIe carrier card; motherboard M.2 slots are not used
- Cluster target: existing Talos cluster `ryzen`, Kubernetes contexts `galactic-lan` / `galactic-tailscale`

Safety notes:

- Do not commit BMC credentials, Talos secrets, generated machine configs, or order/procurement metadata.
- Do not reset the BMC or host from this repo. Use the BMC only after verifying
  the target state live.
- Do not add transferred Ceph OSD disks to Rook until their `/dev/disk/by-id/*`
  names and prior OSD ownership are verified.
- Rook-Ceph wipes disks listed under `cephClusterSpec.storage.nodes[].devices`.

Docs:

- `devices/turin/docs/cluster-join-plan.md` (join + Ceph OSD migration plan)
- `devices/turin/docs/bmc-fan-bringup.md` (BMC and fan alert notes)
- `devices/turin/docs/nvidia-gpu-on-talos.md` (NVIDIA driver/runtime plan)
- `devices/turin/docs/kubevirt-on-turin.md` (KubeVirt runtime and canary checks)
- `devices/turin/docs/ceph-recreate-three-osds.md` (destructive no-Kingston OSD recreate runbook)
- `devices/turin/docs/local-nvme-scratch.md` (single-host NVMe scratch/cache runbook)
- `devices/turin/docs/rook-ceph-turin-recreate-osds-values-draft.yaml` (draft-only Rook storage node snippet; not an Argo input)

Manifests:

- `devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml` (clean Talos install to the 4TB ORICO NVMe, wipe enabled)
- `devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml` (Talos v1.13.4 Image Factory installer with Tailscale + NVIDIA open GPU kernel module LTS extensions)
- `devices/turin/manifests/hostname.patch.yaml` (Talos hostname patch)
- `devices/turin/manifests/etcd-lan-subnet.patch.yaml` (pin etcd peer/client addressing to the Turin LAN subnet)
- `devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml` (pin kubelet node IP selection to the Turin LAN subnet)
- `devices/turin/manifests/kubelet-maxpods.patch.yaml` (set kubelet `maxPods` to 500)
- `devices/turin/manifests/nvidia-kernel-modules.patch.yaml` (load the NVIDIA kernel modules from the Talos system extension)
- `devices/turin/manifests/time-servers.patch.yaml` (match the working control-plane nodes' explicit NTP servers)
- `devices/turin/manifests/tailscale-dns.patch.yaml` (Talos DNS settings for node-level Tailscale)
- `devices/turin/manifests/tailscale-extension-service.template.yaml` (template for generated, gitignored Tailscale auth config)
- `devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml` (Image Factory schematic source)
- `devices/turin/manifests/local-path-scratch-intel.patch.yaml` (gated local-only scratch user volume on the Intel 256GB NVMe)
- `devices/turin/manifests/local-path-scratch-transcend.patch.yaml` (gated local-only scratch user volume on the Transcend 256GB NVMe)

The 500-pod kubelet cap is a deliberate high-density exception; validate `/23`
PodCIDR allocation and node pressure before increasing ARC runner concurrency.

Related:

- Existing cluster inventory: `devices/galactic/README.md`
- Canonical control-plane join runbook: `devices/galactic/docs/add-control-plane-node.md`
- Kubernetes access paths: `docs/runbooks/galactic-kubernetes-access.md`
- Rook-Ceph on Talos runbook: `docs/runbooks/rook-ceph-on-talos.md`
- Rook-Ceph values: `argocd/applications/rook-ceph/cluster-values.yaml`
