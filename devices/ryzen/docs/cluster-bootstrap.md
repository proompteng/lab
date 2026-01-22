# Ryzen Talos bootstrap (USB install)

This runbook is for the Ryzen Talos node booted from USB at `192.168.1.194`.
It keeps the setup reproducible by using the patches in `devices/ryzen/manifests`
plus the existing Talos/KubeVirt docs in this repo.

## Manifest inventory (ryzen)

Node-level patches:
- `devices/ryzen/manifests/ephemeral-volume.patch.yaml` (limit system disk to 100GiB)
- `devices/ryzen/manifests/blockfile.patch.yaml` (user volume for blockfile scratch, 500GB)
- `devices/ryzen/manifests/local-path.patch.yaml` (user volume for local-path, fixed 1400GB)
- `devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml` (allow workloads on single-node controlplane)
- `devices/ryzen/manifests/hostname.patch.yaml` (set Talos hostname to `ryzen`, optional if the generated config already sets it)
- `devices/ryzen/manifests/tailscale-extension-service.yaml` (Tailscale extension service config)
- `devices/ryzen/manifests/amdgpu-extensions.patch.yaml` (AMD GPU extensions; fill in versions)
- `devices/ryzen/manifests/kata-firecracker.patch.yaml` (enable blockfile + kata-fc runtime)
- `devices/ryzen/manifests/kubelet-manifests.patch.yaml` (keep /etc/kubernetes writable for kubelet bootstrap)

Related docs:
- `devices/ryzen/docs/node-level-dependencies.md`
- `docs/kata-firecracker-talos/README.md`
- `docs/kata-firecracker-talos/rebuild-from-scratch.md`
- `docs/kubevirt/workers-ryzen.md`

## 1) Generate Talos config (store in `devices/ryzen/`)

These files are gitignored on purpose:
- `devices/ryzen/controlplane.yaml`
- `devices/ryzen/worker.yaml`
- `devices/ryzen/talosconfig`

Generate configs with the node endpoint. Confirm the install disk (likely
`/dev/nvme0n1` on the 2TB NVMe) before running.

```bash
# Example for a single-node controlplane endpoint
# (adjust the endpoint if you use a load balancer)

export TALOSCONFIG=$PWD/devices/ryzen/talosconfig

talosctl gen config ryzen https://192.168.1.194:6443 \
  --output-dir devices/ryzen \
  --install-disk /dev/nvme0n1
```

## 2) Apply disk layout + node patches

Talos only applies volume sizing at install time. Make sure these patches are
in place before the first `apply-config` / install.

### 2.1 System disk size (100GiB)

The EPHEMERAL volume is capped at 100GiB with this patch:

- `devices/ryzen/manifests/ephemeral-volume.patch.yaml`

### 2.2 User volume for local-path

The local-path provisioner uses a fixed 1.4TB (1400GB) user volume on the NVMe disk,
leaving space for the 500GB blockfile volume and the 100GiB system/EPHEMERAL partition
plus GPT/boot overhead:

- `devices/ryzen/manifests/local-path.patch.yaml`

### 2.3 User volume for blockfile scratch

Firecracker blockfile scratch uses a dedicated 500GB user volume:

- `devices/ryzen/manifests/blockfile.patch.yaml`

### 2.4 Optional patches

- `devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml` (single-node)
- `devices/ryzen/manifests/hostname.patch.yaml`
- `devices/ryzen/manifests/tailscale-extension-service.yaml`
- `devices/ryzen/manifests/amdgpu-extensions.patch.yaml`
- `devices/ryzen/manifests/kata-firecracker.patch.yaml` (reboot required)

### 2.5 Apply config with patches

Use config patches so the generated files stay clean and reproducible:

```bash
export TALOSCONFIG=$PWD/devices/ryzen/talosconfig

# First install from maintenance mode (USB boot)
talosctl apply-config --insecure -n 192.168.1.194 -e 192.168.1.194 \
  -f devices/ryzen/controlplane.yaml \
  --config-patch @devices/ryzen/manifests/ephemeral-volume.patch.yaml \
  --config-patch @devices/ryzen/manifests/blockfile.patch.yaml \
  --config-patch @devices/ryzen/manifests/local-path.patch.yaml

# Optional patches you can add at install time:
#   --config-patch @devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml
#   --config-patch @devices/ryzen/manifests/hostname.patch.yaml
#   --config-patch @devices/ryzen/manifests/tailscale-extension-service.yaml
#   --config-patch @devices/ryzen/manifests/amdgpu-extensions.patch.yaml
#   --config-patch @devices/ryzen/manifests/kata-firecracker.patch.yaml
#   --config-patch @devices/ryzen/manifests/kubelet-manifests.patch.yaml
```

## 3) Bootstrap the cluster

For a brand new controlplane, run the bootstrap step once:

```bash
talosctl bootstrap -n 192.168.1.194
```

Wait for Kubernetes API to become available, then merge kubeconfig.

```bash
talosctl kubeconfig -n 192.168.1.194 -e 192.168.1.194 --force --context ryzen ~/.kube/config
```

Capture the live Talos config for audit/repro:

```bash
talosctl -n 192.168.1.194 -e 192.168.1.194 get machineconfig -o yaml > devices/ryzen/node-machineconfig.yaml
```

## 4) KubeVirt + Firecracker

KubeVirt is installed via Argo CD and Firecracker is enabled through
Talos + Kata configuration. Use these runbooks for the full procedure:

- `docs/kata-firecracker-talos/README.md`
- `docs/kata-firecracker-talos/rebuild-from-scratch.md`

The KubeVirt workers VM setup is documented here:

- `docs/kubevirt/workers-ryzen.md`

## 5) Argo CD cluster re-registration (ryzen)

Once the new cluster is ready, remove the old Argo CD cluster entry and
re-add the new one so ApplicationSets target `destinationName: ryzen`.

```bash
argocd cluster list
argocd cluster rm ryzen

# Use the kubeconfig context for the new cluster
argocd cluster add <kube-context> --name ryzen
```

## 6) Argo CD applications that target ryzen

Argo CD uses ApplicationSets with `clusters: ryzen` entries. The current
ryzen-scoped apps include:

- `argocd/applicationsets/bootstrap.yaml`: `local-path`
- `argocd/applicationsets/platform.yaml`: `kubevirt`, `cdi`, `workers`, `kata-containers`

When the cluster is registered, these ApplicationSets should render the
`*-ryzen` Applications automatically.
