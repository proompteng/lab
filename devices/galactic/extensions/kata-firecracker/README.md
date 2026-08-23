# Kata multi-runtime Talos extension

This is one Talos system extension for `linux/amd64` and `linux/arm64`. It installs Kata Containers `4.1.0`
`runtime-rs` and exposes four containerd handlers:

| RuntimeClass | Kata handler | VMM | Root filesystem |
| --- | --- | --- | --- |
| `kata-qemu` | `kata-qemu` | QEMU | containerd overlayfs through virtio-fs |
| `kata-clh` | `kata-clh` | Cloud Hypervisor | containerd overlayfs through virtio-fs |
| `kata-fc` | `kata-fc` | Firecracker `1.12.1` | containerd `blockfile` snapshotter |
| `kata-dragonball` | `kata-dragonball` | built-in Dragonball | inline virtio-fs |

There is no custom controller, CRD, AgentRun, privileged launcher, or KubeVirt dependency. Kubernetes creates a Pod
with `runtimeClassName`; containerd invokes the shared Kata shim; the selected Kata configuration starts and owns the
guest VM.

## Contents

- `/etc/cri/conf.d/10-kata-runtimes.part`: blockfile snapshotter plus the four CRI handlers;
- `/usr/local/bin/containerd-shim-kata-v2`: the shared Kata `runtime-rs` shim;
- QEMU, Cloud Hypervisor, Firecracker, jailer, and virtiofsd executables;
- the Kata guest image, standard guest kernel, and Dragonball guest kernel;
- a deterministic 512 MiB ext4 scratch image for containerd's blockfile snapshotter;
- architecture-specific QEMU firmware and data files.

The Kata `4.1.0` arm64 release archive contains the Cloud Hypervisor binary but omits its generated configuration.
`configuration-clh-runtime-rs.toml` is the generated config from the same `4.1.0` release archive with only
`/opt/kata` rewritten to Talos' `/usr/local` extension prefix. The configuration is architecture-neutral; upstream
runtime-rs and virtualization documentation support Cloud Hypervisor on x86_64 and aarch64.

## Build

The workflow builds both architectures, publishes a multi-architecture extension, signs its immutable digest with
Cosign, and publishes a signed combined `v1.13.9` extension catalog for the self-hosted Image Factory. It also produces
and signs three architecture-specific Talos installers as independent build receipts:

- `ryzen-amd64`: Kata plus AMDGPU, AMD microcode, glibc, and Tailscale;
- `turin-amd64`: Kata plus the NVIDIA LTS kernel/toolkit extensions and Tailscale;
- `altra-arm64`: Kata plus the NVIDIA LTS kernel/toolkit extensions and Tailscale.

For a local extension-only validation:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/proompteng/talos-kata-runtimes:4.1.0-talos-v1.13.9 \
  devices/galactic/extensions/kata-firecracker
```

After CI publishes the extension, build an installer only from its immutable digest:

```bash
devices/galactic/extensions/kata-firecracker/build-installer.sh \
  ryzen-amd64 \
  ghcr.io/proompteng/talos-kata-runtimes@sha256:<extension-digest> \
  _out/kata-runtimes/ryzen
```

## Activation

Installing the extension changes the immutable Talos installer and reboots the node. Roll out one node at a time only
after the Kubernetes, etcd, and Ceph gates in the cluster runbook pass. The custom Ryzen installer replaces the stock
Kata extension; it does not install both copies.

Omni does not select these installers from a `machine.install.image` config patch. The NUC Image Factory reads the
signed combined catalog and generates the desired per-machine schematic from each machine's `systemExtensions`. See
`devices/nuc/image-factory/README.md` for the factory and registry-mirror handoff.

Talos disables containerd's built-in `blockfile` snapshotter in `/etc/cri/containerd.toml`, and its default CRI image
settings discard layer blobs after overlayfs unpack. Each Kata-enabled machine patch in
`devices/galactic/omni/cluster-template.yaml` therefore removes only `io.containerd.snapshotter.v1.blockfile` from
`disabled_plugins` and sets `discard_unpacked_layers = false` plus `use_local_image_pull = false` in
`/etc/cri/conf.d/20-customization.part`. Omni applies those files and restarts CRI; without both settings,
Firecracker fails before guest boot.

Argo CD application `kata-runtimes` owns the RuntimeClasses and, after publishing the agent image, the long-running
canary DaemonSets. Each RuntimeClass has an independent node selector, so installing a handler does not make a node
eligible by itself.

For each node and runtime, first verify the extension, containerd service, and handler configuration. Then add only
that runtime's activation label, let its canary boot, and collect guest plus host-side VMM evidence. Remove the label
immediately if the canary fails; retain it only after the proof passes:

```bash
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-qemu=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-clh=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-fc=ready --overwrite
kubectl --context galactic-lan label node <node> runtime.proompteng.ai/kata-dragonball=ready --overwrite
```

The four canaries remain running for inspection. `verify-runtimes.sh` captures their guest boot IDs and kernel
releases, maps each Pod to its Talos CRI sandbox, and verifies the requested host VMM. Dragonball is built into the
Kata shim, so it deliberately has no separate VMM process.

Firecracker cannot use an overlayfs root inside the guest. Its handler alone selects containerd `2.2`'s built-in
`blockfile` snapshotter. The bundled 512 MiB scratch filesystem limits each ephemeral container root filesystem to
512 MiB; persistent data belongs on Kubernetes volumes. The Firecracker configuration caps `default_maxvcpus` at
32, matching Firecracker `1.12.1`; leaving Kata's generated value at `0` expands it to the host CPU count and makes
runtime validation fail on Turin's 128-CPU host.
