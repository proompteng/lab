# Ryzen (Talos) Node-Level Dependencies

This document captures the current research and source-of-truth links for installing **node-level** dependencies on the Talos-based Ryzen cluster. It is intentionally detailed so it can be used as a repeatable runbook. All URLs below point to authoritative vendor or upstream sources.

## Why node-level dependencies are different on Talos

Talos is an immutable OS. You do **not** install packages at runtime; instead, you add **system extensions** and re-install or upgrade the node image. System extensions are only activated during install/upgrade, and Talos keeps the root filesystem read-only. Because of this, node-level dependencies (GPU drivers, Tailscale, etc.) must be delivered via **system extensions** and **extension services** rather than by Argo CD or Kubernetes DaemonSets. See Talos system extensions docs for the model and lifecycle. https://www.talos.dev/latest/talos-guides/configuration/system-extensions/

## Source-of-truth references (keep current)

### Talos platform (extensions + image factory)
- System extensions overview and lifecycle: https://www.talos.dev/latest/talos-guides/configuration/system-extensions/
- Image Factory (build custom Talos images with extensions): https://www.talos.dev/v1.10/learn-more/image-factory/
- ExtensionServiceConfig schema (for configuring extension services): https://www.talos.dev/v1.10/reference/configuration/extensions/extensionserviceconfig/
- Extension services (how extension services run as privileged containers): https://www.talos.dev/latest/advanced/extension-services/
- Official extensions catalog (includes `siderolabs/tailscale` image): https://github.com/siderolabs/extensions
- Local storage (user volumes, mount paths, and system volume layout): https://www.talos.dev/latest/kubernetes-guides/configuration/local-storage/
- System volumes (how Talos carves disks into system/user volumes): https://www.talos.dev/latest/learn-more/system-volumes/

### Tailscale
- Tailscale extension exists in the official extensions catalog (see Network section): https://github.com/siderolabs/extensions
- Tailscale extension configuration variables (TS_AUTHKEY, TS_HOSTNAME, TS_ROUTES): https://deepwiki.com/siderolabs/extensions/3.4-networking-extensions
- Auth keys (types, tags, pre-approved, expiry): https://tailscale.com/kb/1085/auth-keys
- Key prefixes (distinguish `tskey-auth` vs `tskey-api`): https://tailscale.com/kb/1277/key-prefixes

### AMD GPU (ROCm) on Talos
- Talos AMD GPU support guide (extensions, OS-level enablement, ROCm operator): https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu
- AMD GPU device plugin for Kubernetes (resource name, deployment model): https://instinct.docs.amd.com/projects/k8s-device-plugin/en/latest/
- ROCm k8s device plugin upstream (manifest examples): https://github.com/ROCm/k8s-device-plugin

---

## System extensions: how to install node-level components

### 1) Identify required extensions
Use the official extensions catalog to confirm the extension name and image registry. The catalog lists `tailscale` under the Network section as `ghcr.io/siderolabs/tailscale`, and AMD GPU support is documented in the Talos AMD GPU guide (requires `siderolabs/amdgpu` and `siderolabs/amd-ucode`).
- https://github.com/siderolabs/extensions
- https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu

### 2) Build/upgrade Talos image with extensions
Talos system extensions are only activated during **install or upgrade**. The recommended workflow is to generate a Talos image using the **Image Factory** and include the required system extensions. The Image Factory UI provides a schematic that results in a custom installer image you can set as `machine.install.image` in your Talos machine config. See:
- https://www.talos.dev/v1.10/learn-more/image-factory/
- https://www.talos.dev/latest/talos-guides/configuration/system-extensions/

### 3) Apply and upgrade
Update the Talos machine config to reference the new installer image and (if needed) specify `.machine.install.extensions`. Then perform a Talos upgrade using the updated machine config. Re-using the same Talos version is valid if only extensions changed.
- https://www.talos.dev/latest/talos-guides/configuration/system-extensions/

### 4) Verify extensions are active
Use `talosctl get extensions` to verify the extension list on each node. This is the canonical way to confirm the OS picked up the extension at boot.
- https://www.talos.dev/latest/talos-guides/configuration/system-extensions/

---

## Tailscale node-level install (Talos extension)

### Overview
Tailscale is delivered on Talos as a **system extension** with a corresponding **extension service**. You must:
1. Include the `siderolabs/tailscale` extension in the Talos image.
2. Provide an `ExtensionServiceConfig` so the Tailscale daemon can authenticate and optionally advertise routes.

### Required extension
The official extensions catalog lists the Tailscale extension under Network as `ghcr.io/siderolabs/tailscale`.
- https://github.com/siderolabs/extensions

### Tailscale configuration (ExtensionServiceConfig)
Talos uses `ExtensionServiceConfig` to provide environment variables and config files to extension services. The Tailscale extension is configured using environment variables such as `TS_AUTHKEY`, `TS_HOSTNAME`, and `TS_ROUTES`.
- ExtensionServiceConfig schema: https://www.talos.dev/v1.10/reference/configuration/extensions/extensionserviceconfig/
- Tailscale extension env vars: https://deepwiki.com/siderolabs/extensions/3.4-networking-extensions

Example `ExtensionServiceConfig`:

```yaml
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: tailscale
environment:
  - TS_AUTHKEY=${TAILSCALE_AUTHKEY}
  - TS_HOSTNAME=ryzen
  - TS_ROUTES=10.96.0.0/12,10.244.0.0/16
```

> The routes above are examples; match your cluster CIDRs.

Template source-of-truth: `devices/ryzen/manifests/tailscale-extension-service.template.yaml`.
Generate a local patch (gitignored) with:

```bash
bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
```

To ensure Talos resolves tailnet hostnames (including `registry.ide-newton.ts.net`) add
`devices/ryzen/manifests/tailscale-dns.patch.yaml` when applying config.

### Auth key guidance
Use a **tagged, pre-approved** auth key for servers to avoid interactive approvals and to scope permissions via ACLs. Tailscale’s auth key docs explain key types, tags, and expiry behavior. The key prefix doc clarifies the `tskey-auth` prefix for auth keys.
- https://tailscale.com/kb/1085/auth-keys
- https://tailscale.com/kb/1277/key-prefixes

### Apply config to Talos
ExtensionServiceConfig documents are applied to Talos machine config (for example via `talosctl patch mc`). DeepWiki’s extension overview shows applying the config via patch and verifying it with `talosctl`.
- https://deepwiki.com/siderolabs/extensions/3.4-networking-extensions

For the Ryzen node, generate the patch file first:

```bash
bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
```

### Ryzen reproducible setup (Talos v1.12.1)
This is the exact workflow used to enable node-level Tailscale on the Ryzen Talos node.

#### 1) Build a new Image Factory schematic (add tailscale)
Keep existing extensions and add `siderolabs/tailscale` (tracked in the repo):

```yaml
devices/ryzen/manifests/ryzen-tailscale-schematic.yaml
```

Create the schematic and capture its ID:

```bash
curl -sS -X POST --data-binary @devices/ryzen/manifests/ryzen-tailscale-schematic.yaml https://factory.talos.dev/schematics | jq -r .id
```

#### 2) Patch machine config (image + ExtensionServiceConfig)
Use a tagged, pre-approved auth key in `TAILSCALE_AUTHKEY` and apply the patch:

```bash
export TALOSCONFIG=~/.talos/config
export TAILSCALE_AUTHKEY=tskey-auth-REDACTED

cat > /tmp/ryzen-tailscale.patch.yaml <<'EOF'
machine:
  install:
    image: factory.talos.dev/metal-installer/<schematic-id>:v1.12.1
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: tailscale
environment:
  - TS_AUTHKEY=${TAILSCALE_AUTHKEY}
  - TS_HOSTNAME=ryzen
  - TS_ROUTES=10.96.0.0/12,10.244.0.0/16
EOF

talosctl patch machineconfig --patch @/tmp/ryzen-tailscale.patch.yaml
```

#### 3) Upgrade Talos to activate the extension
Extensions activate only on install/upgrade.

```bash
talosctl upgrade --image factory.talos.dev/metal-installer/<schematic-id>:v1.12.1
```

#### 4) Validate

```bash
talosctl get extensions
talosctl get extensionserviceconfig
talosctl service
talosctl logs ext-tailscale --tail 200
```

Expected: `tailscale` extension installed, `ext-tailscale` service running, and logs show active login with `ryzen` hostname.

#### 5) Drain guardrail (kubevirt PDB)
If the upgrade drain hangs, check for blocking PDBs. The Ryzen node had:

```bash
kubectl -n kubevirt get pdb
```

Deleting `virt-controller-pdb` unblocked the drain during the upgrade. Recreate it after the node returns Ready if needed.

### Validate
- Confirm Tailscale extension is installed: `talosctl get extensions`
- Confirm the extension service is running and logs are visible via `talosctl service` / `talosctl logs` for the extension service name (extension services are documented by Talos).
  - https://www.talos.dev/latest/advanced/extension-services/

---

## Local-path storage (Talos user volume)

### Overview
Talos uses **user volumes** to carve dedicated storage out of the system disk. For the Ryzen node, we allocate a **fixed 1.405TB (1405GB)** user volume named `local-path-provisioner`, which Talos mounts at `/var/mnt/local-path-provisioner`. The Local Path Provisioner is then configured to use that mount point for PVs. The size is capped to leave room for the 500GB blockfile volume plus the 100GiB system/EPHEMERAL partition on the same NVMe.

Sources:
- Talos local storage guide (user volumes + mount path): https://www.talos.dev/latest/kubernetes-guides/configuration/local-storage/
- Talos system volumes (disk layout and sizing): https://www.talos.dev/latest/learn-more/system-volumes/

### Repo source-of-truth
- User volume config: `devices/ryzen/manifests/local-path.patch.yaml`
- Local-path-provisioner config map patch: `argocd/applications/local-path/patches/local-path-config.patch.yaml`

### User volume manifest (1.405TB fixed)

```yaml
apiVersion: v1alpha1
kind: UserVolumeConfig
name: local-path-provisioner
provisioning:
  diskSelector:
    match: disk.transport == 'nvme' || disk.transport == 'sata'
  minSize: 1405GB
  maxSize: 1405GB
  grow: false
```

Sizing note for the 2TB NVMe: we measured the raw disk size via
`talosctl get disks` and `/proc/partitions`. After the 2GB boot partition,
META (1MB), STATE (100MB), EPHEMERAL (100GiB), and blockfile (500GB), the
remaining usable space is ~1405GB. If the disk model changes, recalc:

```
local-path = disk_size - boot - META - STATE - EPHEMERAL - blockfile
```

### Apply to the Ryzen Talos node

```bash
export TALOSCONFIG=~/.talos/config
talosctl patch machineconfig --patch @devices/ryzen/manifests/local-path.patch.yaml
```

### Resizing note (single NVMe)
The Ryzen node has only one NVMe disk, so `local-path-provisioner` and `blockfile-scratch` share it. Talos will **not** shrink an existing partition. If you change sizes after the first install, wipe the old partition label so Talos can re-create it:

```bash
talosctl reset -n 192.168.1.194 \
  --wipe-mode system-disk \
  --system-labels-to-wipe u-local-path-provisioner \
  --reboot --graceful=false
```

### Configure local-path-provisioner
The Argo CD application `local-path` patches the ConfigMap to use `/var/mnt/local-path-provisioner`:

```json
{
  "nodePathMap":[
    {
      "node":"DEFAULT_PATH_FOR_NON_LISTED_NODES",
      "paths":["/var/mnt/local-path-provisioner"]
    }
  ]
}
```

### Validate

```bash
talosctl get volumestatuses
kubectl get storageclass
kubectl -n local-path-storage get pods
```

Expected: the `local-path` StorageClass exists and the provisioner is Running on the Ryzen node, using the `/var/mnt/local-path-provisioner` path.

---

## Blockfile scratch (Talos user volume)

### Overview
Firecracker-backed Kata containers use containerd’s **blockfile** snapshotter, which
requires a scratch file on disk. We dedicate a **500GB** user volume named
`blockfile-scratch`, mounted at `/var/mnt/blockfile-scratch`, while the scratch
file itself lives under `/var/mnt/blockfile-scratch/containerd-blockfile/scratch`
so CRI can read it during boot
without waiting for the user volume mount.

Important: **do not enable the blockfile snapshotter until the scratch file exists**.
If containerd starts with blockfile enabled and the scratch file missing, CRI fails
to load and the node never becomes Ready.

Sources:
- Talos local storage guide (user volumes + mount path): https://www.talos.dev/latest/kubernetes-guides/configuration/local-storage/
- Talos system volumes (disk layout and sizing): https://www.talos.dev/latest/learn-more/system-volumes/

### Repo source-of-truth
- User volume config: `devices/ryzen/manifests/blockfile.patch.yaml`
- Containerd blockfile config: `devices/ryzen/manifests/kata-firecracker.patch.yaml`
- Scratch creation DaemonSet: `argocd/applications/kata-containers/blockfile-scratch-daemonset.yaml`
  - The `hold` container intentionally does not mount the host path so Talos can
    cleanly unmount the user volume during reconciles.

### Runtime paths (Talos kata-containers extension)
The official `siderolabs/kata-containers` extension installs binaries under
`/usr/local`:
- `containerd-shim-kata-v2`: `/usr/local/bin/containerd-shim-kata-v2`
- default config: `/usr/local/share/kata-containers/configuration.toml`

Firecracker binaries are **not** bundled in the stock extension; if you need a
Firecracker VMM, ship it via a custom Talos extension and point `ConfigPath` to
your Firecracker config under `/var`.

### User volume manifest (500GB)

```yaml
apiVersion: v1alpha1
kind: UserVolumeConfig
name: blockfile-scratch
provisioning:
  diskSelector:
    match: disk.transport == 'nvme'
  minSize: 500GB
  maxSize: 500GB
```

### Apply to the Ryzen Talos node

```bash
export TALOSCONFIG=~/.talos/config
talosctl patch machineconfig --patch @devices/ryzen/manifests/blockfile.patch.yaml
```

### Validate
- `talosctl get volumemountstatuses | rg blockfile-scratch`
- `/var/mnt/blockfile-scratch/containerd-blockfile/scratch` exists after the blockfile DaemonSet runs.

### Enable kata/firecracker after scratch exists

1) Register the cluster in Argo CD so the `kata-containers` app applies the
   blockfile scratch DaemonSet.
2) Confirm the scratch file exists on the node.
3) Apply `devices/ryzen/manifests/kata-firecracker.patch.yaml` with a reboot.

## AMD GPU (ROCm) node-level install

### Overview
Talos AMD GPU support requires **OS-level enablement** plus a **Kubernetes operator or device plugin** to expose GPUs to pods. Talos supports AMD GPUs by loading the Linux `amdgpu` driver at boot, but you must enable system extensions for firmware/driver support and then install ROCm components in-cluster.
- https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu

### OS-level enablement (Talos extensions)
The Talos AMD GPU guide instructs you to enable AMD GPU support by installing the `siderolabs/amdgpu` and `siderolabs/amd-ucode` system extensions. It also calls out extra kernel arguments for AMD AI 395+ (Strix Halo) systems. Embed these via boot assets (Image Factory schematic or imager); `machine.install.extensions` is deprecated.
- https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu

Example Image Factory schematic (Ryzen AI Max+ 395 / Strix Halo):

```yaml
customization:
  extraKernelArgs:
    - amd_iommu=off
    - amdgpu.gttsize=131072
    - ttm.pages_limit=33554432
  systemExtensions:
    officialExtensions:
      - siderolabs/amdgpu
      - siderolabs/amd-ucode
```

Use the extensions catalog or image-digest lookup approach from the extensions repo to pin an exact digest for your Talos version if you prefer image digests.
- https://github.com/siderolabs/extensions

Reproducible build notes for the Ryzen node live in:
- `devices/ryzen/docs/bosgame-m5-talos-drivers.md`
- `docs/kata-firecracker-talos/production-firecracker-plan.md`

### Kubernetes layer: ROCm GPU Operator
The Talos AMD GPU guide recommends deploying the ROCm GPU Operator to surface GPU resources to workloads. It includes Helm install steps and verification commands.
- https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu

### Kubernetes layer: device plugin
If you’re not using the full operator or want explicit control, the AMD GPU device plugin can be deployed as a DaemonSet. The official docs and upstream repo describe installation and the resource type (`amd.com/gpu`).
- https://instinct.docs.amd.com/projects/k8s-device-plugin/en/latest/
- https://github.com/ROCm/k8s-device-plugin

Ryzen-specific install (pinned manifests + verification steps):
- `devices/ryzen/docs/amdgpu-device-plugin.md`

### Validate GPU visibility
From the Talos guide and AMD docs:
- Verify extensions are active: `talosctl get extensions`
- Verify GPU detection in Talos: `talosctl get devices.pci` and `talosctl logs -k` (Talos guide)
- Verify Kubernetes resources: `kubectl describe node <node-name> | grep -i gpu` or list `amd.com/gpu` capacity via `kubectl get nodes -o custom-columns=...`
- https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu
- https://instinct.docs.amd.com/projects/k8s-device-plugin/en/latest/

---

## Operational checklist (quick reference)

### Tailscale
1. Pick `siderolabs/tailscale` in Image Factory or add extension image to `machine.install.extensions`.
2. Upgrade Talos so extensions activate.
3. Apply `ExtensionServiceConfig` with `TS_AUTHKEY`, `TS_HOSTNAME`, `TS_ROUTES`.
4. Validate with `talosctl get extensions` and extension service status/logs.

### AMD GPU
1. Add `siderolabs/amdgpu` + `siderolabs/amd-ucode` to system extensions.
2. Upgrade Talos to activate drivers/firmware.
3. Install ROCm GPU Operator (or AMD GPU device plugin) in Kubernetes.
4. Verify GPU resources (`amd.com/gpu`) and run a test workload.

---

## Notes on storage of secrets

Tailscale auth keys are sensitive and should be stored in a secrets manager rather than in Git. Tailscale’s key management docs stress secure handling of keys and recommend using a secrets manager. https://tailscale.com/kb/1252/key-secret-management
