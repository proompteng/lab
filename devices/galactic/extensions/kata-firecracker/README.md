# Kata Firecracker Talos extension

This extension installs Kata Containers `4.1.0` runtime-rs with Firecracker `1.12.1`, the Firecracker version pinned
by that Kata release. It supports `linux/amd64` and `linux/arm64` extension images.

The image is a Talos system extension. It contains only files under the Talos extension allowlists:

- `/etc/cri/conf.d/10-kata-firecracker.part` registers the `kata-fc` containerd handler;
- `/usr/local/bin/containerd-shim-kata-fc-v2` is the Kata runtime-rs shim;
- `/usr/local/bin/firecracker` and `/usr/local/bin/jailer` are the VMM executables;
- `/usr/local/share/kata-containers/` contains the pinned guest kernel, root image and Firecracker configuration.

The containerd fragment intentionally does not pass pod annotations to Kata. In particular, workloads cannot select
an arbitrary Kata configuration path.

## Build

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/proompteng/talos-kata-firecracker:4.1.0-talos-v1.13.9 \
  --push \
  devices/galactic/extensions/kata-firecracker
```

Always deploy the resulting digest, never the mutable tag. The release archive and Firecracker archive checksums are
pinned in the Dockerfile.

The release workflow publishes three Talos `v1.13.9` installer variants from the extension digest:

- `ryzen-amd64`: Kata plus the existing AMD GPU, AMD microcode, glibc and Tailscale extensions;
- `nvidia-amd64`: Kata plus the existing NVIDIA LTS and Tailscale extensions for Turin;
- `nvidia-arm64`: Kata plus the existing NVIDIA LTS and Tailscale extensions for Altra.

Build one of those installers locally with the same digest-pinned inputs:

```bash
devices/galactic/extensions/kata-firecracker/build-installer.sh \
  ryzen-amd64 \
  ghcr.io/proompteng/talos-kata-firecracker@sha256:<extension-digest> \
  _out/kata-firecracker/ryzen
```

The Ryzen profile deliberately omits the official `siderolabs/kata-containers` extension. Keeping it would install
Kata 3.32.0 over the same paths as this Kata 4.1.0 extension.

## Install on Talos

The public Talos Image Factory accepts only official extensions. The release workflow therefore builds custom Talos
installers with the digest-pinned `ghcr.io/siderolabs/imager:v1.13.9` image and preserves each node's existing
architecture-specific extensions. Use the signed installer digest from the workflow summary and roll it one node at a
time.

After each reboot, verify the extension and handler before continuing:

```bash
talosctl --context ryzen --nodes <node-address> get extensions
talosctl --context ryzen --nodes <node-address> service containerd
```

Apply `runtime-class.yaml` only after the handler is present. A node is eligible for `kata-fc` workloads only after a
real Firecracker guest has passed the canary and the node is labeled:

```bash
kubectl --context galactic-lan label node <node-name> runtime.proompteng.ai/kata-firecracker=ready
```

Firecracker cannot share an overlayfs root with the guest. The workload path also needs a supported block-backed
snapshotter or an explicitly validated guest-pull configuration before a `kata-fc` pod can start.
