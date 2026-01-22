# Investigation: Kata + Firecracker on Talos (ryzen)

Date: 2026-01-15
Cluster: ryzen (Talos v1.12.1, Kubernetes v1.35.0)
Node: 192.168.1.194

## Goal
Run Kata Containers with Firecracker (runtimeClass `kata-fc`) on the ryzen Talos cluster and verify with a test pod. Provide reliable proof that Firecracker-backed Kata pods start.

## Environment
- OS: Talos v1.12.1
- Kubernetes: v1.35.0
- containerd: v2.1.6
- Kata system extension present (paths under `/opt/kata/...`)
- RuntimeClass: `kata-fc`

Key binaries found:
- `/opt/kata/bin/firecracker`
- `/opt/kata/bin/containerd-shim-kata-v2`
- `/opt/kata/share/defaults/kata-containers/configuration-fc.toml`

## Summary of Findings
1) **Firecracker requires a block-backed rootfs**, which in containerd is typically provided via the **devmapper snapshotter**.
2) **Talos’s containerd build on this node does not expose the devmapper snapshotter**, even after adding a devmapper config stanza. As a result, Kata+Firecracker cannot create a sandbox.
3) Attempts to run a `kata-fc` pod fail with:
   - `CreateContainerRequest timed out` (initially)
   - or `failed to mount /run/kata-containers/shared/containers/...: ENOENT`
   - and after configuring devmapper: `snapshotter devmapper was not found: not found`
4) Firecracker never creates its API socket under `/run/vc/firecracker/.../root/run/firecracker.socket`, indicating the VMM never fully starts.

This is a hard blocker unless containerd is rebuilt with devmapper support or the OS/containerd runtime is changed.

## Detailed Timeline & Evidence

### 1) Confirm runtime and node
Commands:
```
kubectl --context=ryzen get nodes -o wide
kubectl --context=ryzen get runtimeclass
```
Result:
- Node `ryzen` Ready on Talos v1.12.1, containerd v2.1.6.
- RuntimeClass `kata-fc` exists.

### 2) Initial failure: CreateContainerRequest timed out
Test pod:
```
apiVersion: v1
kind: Pod
metadata:
  name: kata-fc-test
  namespace: default
spec:
  runtimeClassName: kata-fc
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
  containers:
    - name: busybox
      image: busybox:1.36
      command: ["sh", "-c", "echo kata-fc-ok && sleep 3600"]
```
Symptoms:
- Pod stuck `ContainerCreating`.
- `FailedCreatePodSandBox` with timeout.

Containerd/cri log evidence (tail):
- `getting vm status failed ... /run/vc/firecracker/.../firecracker.socket: no such file or directory`
- `CreateContainerRequest timed out`

Interpretation:
- Kata shim attempts to talk to Firecracker API socket that never appears.

### 3) ConfigPath adjustment
Initially used a custom config under `/var/lib/kata-containers/configuration-fc.toml`, but Talos only allows `machine.files` under `/var`. To remove variables, switched to the **stock config**:

Talos file (`/etc/cri/conf.d/20-customization.part`):
```
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc"]
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc"]
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"
```

Result: timeout errors replaced by rootfs mount ENOENT errors. Firecracker still never starts.

### 4) ENOENT rootfs mount failures
Pod describe showed:
```
failed to mount /run/kata-containers/shared/containers/<id>/rootfs to /run/kata-containers/<id>/rootfs, with error: ENOENT
```

Interpretation:
- Kata expects a block-based rootfs for Firecracker. Without a block snapshotter, rootfs mount path doesn’t materialize.

### 5) Attempted devmapper snapshotter
Added devmapper snapshotter config and runtime snapshotter in CRI config:
```
[plugins."io.containerd.snapshotter.v1.devmapper"]
  pool_name = "containerd-pool"
  root_path = "/var/lib/containerd/io.containerd.snapshotter.v1.devmapper"
  base_image_size = "10GB"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc"]
  snapshotter = "devmapper"
  ...

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc"]
  snapshotter = "devmapper"
  ...
```

Created a loopback-backed thinpool (test-only) via a privileged pod:
- Creates `/var/lib/containerd/io.containerd.snapshotter.v1.devmapper/{data,meta}`
- `dmsetup create containerd-pool ...`

Result:
- `kata-fc-test` failed with:
  `snapshotter devmapper was not found: not found`

### 6) Confirm containerd does not load devmapper
Containerd logs show only `native` and `overlayfs` snapshotters loaded:
```
io.containerd.snapshotter.v1.native
io.containerd.snapshotter.v1.overlayfs
```
No devmapper plugin is present. This indicates the containerd build shipped with Talos here does not include devmapper snapshotter support.

## Root Cause
Firecracker requires block-backed rootfs. On this Talos node, containerd lacks the devmapper snapshotter, so Firecracker cannot mount the root filesystem. This prevents Firecracker from starting and causes Kata shim failures.

## Resolution (Working on 2026-01-15)

Talos ships the **blockfile** snapshotter but disables it in `/etc/cri/containerd.toml`.
Re-enabling blockfile and configuring `kata-fc` to use it makes Firecracker work.

### 1) Re-enable blockfile snapshotter

Overwrite `/etc/cri/containerd.toml` to remove the blockfile entry from
`disabled_plugins`:

```
version = 3

disabled_plugins = [
    "io.containerd.differ.v1.erofs",
    "io.containerd.internal.v1.tracing",
    "io.containerd.snapshotter.v1.erofs",
    "io.containerd.ttrpc.v1.otelttrpc",
    "io.containerd.tracing.processor.v1.otlp",
]

imports = [
    "/etc/cri/conf.d/cri.toml",
]
```

### 2) Configure blockfile + kata-fc runtime

In `/etc/cri/conf.d/20-customization.part`:

```
[plugins."io.containerd.snapshotter.v1.blockfile"]
  root_path = "/var/mnt/blockfile-scratch/containerd-blockfile"
  scratch_file = "/var/mnt/blockfile-scratch/containerd-blockfile/scratch"
  fs_type = "ext4"
  mount_options = []
  recreate_scratch = false

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc"]
  snapshotter = "blockfile"
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc"]
  snapshotter = "blockfile"
  runtime_type = "io.containerd.kata-fc.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes."kata-fc".options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"
```

### 3) Create scratch file (ext4)

Create `/var/mnt/blockfile-scratch/containerd-blockfile/scratch` and format it with ext4:

```
truncate -s 10G /var/mnt/blockfile-scratch/containerd-blockfile/scratch
mkfs.ext4 -F /var/mnt/blockfile-scratch/containerd-blockfile/scratch
```

### 4) Reboot Talos

Reboot is required to reload containerd with the new base config.

### Proof

Blockfile snapshotter loaded:

```
io.containerd.snapshotter.v1              blockfile                linux/amd64    ok
```

Firecracker process running:

```
/firecracker --id ... --config-file /fcConfig.json
```

Guest kernel from inside pod:

```
Linux kata-fc-test 6.12.47 #1 SMP Fri Dec  5 12:15:04 UTC 2025 x86_64 GNU/Linux
```

## Internet Research (Primary Sources)

### Firecracker storage model
- Firecracker’s device model includes `virtio-block` as the storage device. This implies storage (including rootfs) is exposed to the guest as a block device, not a host file share.
  - https://firecracker-microvm.github.io/

### Containerd devmapper snapshotter
- Devmapper snapshotter is a containerd plugin that stores snapshots in filesystem images inside a device-mapper thin pool. It requires creating a thin-pool in advance and configuring containerd to use it.
  - https://fossies.org/linux/containerd/docs/snapshotters/devmapper.md

### Talos containerd configuration merge point
- Talos merges containerd configuration from `/etc/cri/conf.d/20-customization.part` (Talos docs).
  - https://www.talos.dev/v1.11/talos-guides/configuration/containerd/

### Talos custom image build path
- Talos supports building custom images from source (needed if containerd must be rebuilt with devmapper support).
  - https://www.talos.dev/v1.10/advanced/building-images/

### Firecracker + devmapper in the ecosystem
- Flintlock docs explicitly state it relies on containerd’s devmapper snapshotter to provide filesystem devices for Firecracker microVMs, reinforcing the block-backed storage requirement.
  - https://flintlock.liquidmetal.dev/docs/getting-started/containerd/

## What Works
- Kata binaries are present (`/opt/kata/bin/firecracker`, `containerd-shim-kata-v2`).
- RuntimeClass `kata-fc` exists.
- KVM/vsock device nodes exist (`/dev/kvm`, `/dev/vhost-vsock`).
- Blockfile snapshotter is enabled and loaded.
- `kata-fc-test` pod runs successfully.

## What Does Not Work
- Devmapper snapshotter is not available in the Talos containerd build.

## Required Fix Options
1) **Keep blockfile snapshotter** (current working solution).
2) **Custom Talos build/containerd** with devmapper snapshotter enabled (optional).
3) **Use a different VMM** (QEMU or Cloud Hypervisor) if blockfile is not viable.

## Artifacts & References
- Talos config changes live in:
  - `/Users/gregkonush/github.com/devices/ryzen/controlplane.yaml`
  - `/Users/gregkonush/github.com/devices/ryzen/worker.yaml`
- Doc: `docs/kata-firecracker-talos/README.md`

## Cleanup Performed
- Removed helper pods:
  - `blockfile-scratch-init`
  - `ctr-plugins-check`
  - `ctr-fix-pause`

## Next Actions
- Optional: codify the blockfile scratch creation as a GitOps manifest.
- Optional: evaluate a custom Talos/containerd build if devmapper is required.
