# Turin NVIDIA GPU on Talos

Turin has an NVIDIA RTX PRO 6000 Blackwell Max-Q GPU. Talos must boot with
NVIDIA support in the operating system image before Kubernetes can advertise or
schedule `nvidia.com/gpu` workloads.

This is the safe order:

1. Install Talos with an Image Factory installer image that already contains the
   NVIDIA kernel module and NVIDIA container toolkit system extensions.
2. Verify the driver is loaded on the Talos host.
3. Join the existing cluster.
4. Only then enable Kubernetes GPU advertisement through GitOps.

Do not use deprecated `machine.install.extensions` on this new node.

## Talos image

Use the tracked schematic:

- `devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml`

It contains:

- `siderolabs/tailscale`
- `siderolabs/nvidia-open-gpu-kernel-modules-lts`
- `siderolabs/nvidia-container-toolkit-lts`

Generate or confirm the Image Factory schematic ID:

```bash
curl -sS -X POST --data-binary @devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml \
  https://factory.talos.dev/schematics | jq -r .id
```

Expected ID:

```text
6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d
```

Use the installer patch:

- `devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml`

That patch points Talos installation at:

```text
factory.talos.dev/metal-installer/6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d:v1.13.4
```

This keeps system extensions in the Talos image build, not in deprecated machine
config fields.

If the LTS branch does not recognize the Blackwell GPU after boot, create a
production-branch schematic by replacing the NVIDIA extensions with:

```yaml
- siderolabs/nonfree-kmod-nvidia-production
- siderolabs/nvidia-container-toolkit-production
```

Do not switch branches until the LTS image has been verified on the host.

## Apply with first install

Include the installer-image patch with the first real Turin apply:

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

Do not install to the Kingston NVMe if preserving the transferred Ceph OSD set;
that device matched the old `talos-192-168-1-203` metadata device.

## Host validation

After install and reboot, verify the OS-level pieces before changing GitOps:

```bash
talosctl -n <turin-node-ip> -e <endpoint> get extensions | rg 'tailscale|nvidia'
talosctl -n <turin-node-ip> -e <endpoint> read /proc/modules | rg '^nvidia'
talosctl -n <turin-node-ip> -e <endpoint> read /proc/driver/nvidia/version
talosctl -n <turin-node-ip> -e <endpoint> service ext-tailscale status
```

If `/proc/driver/nvidia/version` is missing, stop there. Do not debug this as a
Kubernetes device-plugin issue until the Talos host driver is loaded.

## Kubernetes advertisement

The existing Argo CD app at `argocd/applications/nvidia-gpu-operator` is
configured for VM passthrough and currently disables host container GPU support:

- `driver.enabled=false`
- `toolkit.enabled=false`
- `devicePlugin.enabled=false`

That is correct for Talos driver installation: the GPU Operator must not install
host drivers or host toolkit on Talos. Turin needs a follow-up GitOps change only
after host validation:

1. Label Turin explicitly:

   ```bash
   kubectl --context galactic-tailscale label node turin lab.proompteng.ai/nvidia-gpu=true
   ```

2. Update the GPU Operator values or add a separate Turin-targeted overlay so
   only the Kubernetes advertisement components run for container workloads:

   ```yaml
   driver:
     enabled: false
   toolkit:
     enabled: false
   devicePlugin:
     enabled: true
   gfd:
     enabled: true
   dcgmExporter:
     enabled: true
   migManager:
     enabled: false
   ```

3. Gate those components to the explicit Turin label. Do not make the existing
   VM-passthrough path depend on host container GPU scheduling.

4. Verify Kubernetes sees the GPU:

   ```bash
   kubectl --context galactic-tailscale -n gpu-operator get pods -o wide
   kubectl --context galactic-tailscale get node turin -o json | jq -r '.status.allocatable["nvidia.com/gpu"]'
   kubectl --context galactic-tailscale describe node turin | rg -i 'nvidia.com/gpu|nvidia'
   ```

5. Run a CUDA smoke pod pinned to Turin and confirm `nvidia-smi` sees the RTX PRO
   6000 Blackwell GPU before moving real workloads.

## Failure boundaries

- Driver absent in `/proc/modules`: Talos image problem.
- Driver loaded but no `nvidia.com/gpu`: Kubernetes device-plugin/operator
  problem.
- `nvidia.com/gpu` present but workload fails: runtime class, container image,
  or workload scheduling problem.
- GPU visible but unstable under load: firmware, PCIe power, cooling, or driver
  branch problem; compare LTS vs production only after collecting host evidence.
