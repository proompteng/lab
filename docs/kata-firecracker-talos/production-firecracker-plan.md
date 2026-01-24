# Production Plan: Firecracker on Talos (Ryzen)

This document is the production-grade plan to enable **Firecracker** as the VMM
for Kata Containers on the Talos `ryzen` cluster. It avoids ad-hoc host changes
and follows the Talos system extension model.

## Why this plan

- System extensions are appended to Talos boot assets/installer images, and their
  `rootfs` is bind-mounted into the system, so host binaries (like `firecracker`
  and `jailer`) must be delivered as extensions and applied at install/upgrade time.
- The official `kata-containers` extension config in `extensions` targets
  **cloud-hypervisor** by default; Firecracker is not included.
- Firecracker requires a **block-backed rootfs**. Kata’s Firecracker guide calls
  out block devices as required, and containerd’s **blockfile** snapshotter is the
  VM-friendly option on Talos.

## Current state (ryzen)

- `kata-containers` + `glibc` extensions are installed.
- `/usr/local/bin/containerd-shim-kata-v2` exists.
- `/usr/local/bin/firecracker` and `jailer` do **not** exist.
- Blockfile scratch image exists at:
  `/var/mnt/blockfile-scratch/containerd-blockfile/scratch`
- `kata-fc` runtime config exists and points to:
  `/usr/local/share/kata-containers/configuration.toml` (cloud-hypervisor).

## Target outcome

- Firecracker and jailer binaries installed at `/usr/local/bin`.
- A Firecracker-oriented Kata config available under
  `/usr/local/share/kata-containers/configuration.toml` (or a dedicated path).
- Talos uses the blockfile snapshotter for `kata-fc`.
- `kata-fc` RuntimeClass works and spawns Firecracker microVMs.

## Plan

### 1) Create a Firecracker system extension (production)

Use the local extension packaging under `packages/talos-extensions` as the
source of truth. The Firecracker extension lives in:

- `packages/talos-extensions/firecracker`

Create a new extension that:

- Downloads Firecracker **release binaries** for the target arch (amd64).
- Installs `firecracker` and `jailer` into `/usr/local/bin`.
- Installs a Firecracker-oriented config at:
  `/usr/local/share/kata-containers/configuration.toml` (overwriting the
  Cloud Hypervisor default).

Notes:

- Pin the Firecracker version explicitly (tag or checksum) and align it with
  `kata-containers/versions.yaml`.
- Keep `ConfigPath` pointing at
  `/usr/local/share/kata-containers/configuration.toml` (existing manifests).
- Keep the official `kata-containers` extension for the kata runtime + guest
  assets; the Firecracker extension adds only the VMM bits.

### 2) Build and publish the extension image

Publish the extension image to the **internal registry** and record the digest
for reproducible builds. Build commands live in:

- `packages/talos-extensions/README.md`

Image target:

- `registry.ide-newton.ts.net/lab/firecracker:v1.12.1`

### 3) Build a custom installer image (imager)

Image Factory only accepts **official** extensions via `officialExtensions`,
so build a custom installer locally using the Talos `imager` container (default
image repo: `ghcr.io/siderolabs/imager`) and push it to the internal registry.

Example command (amd64):

```bash
docker run --rm --entrypoint imager \
  -v /tmp/imager-out:/out \
  ghcr.io/siderolabs/imager:v1.12.1 \
  metal \
  --platform metal \
  --arch amd64 \
  --base-installer-image factory.talos.dev/metal-installer/<current-schematic>:v1.12.1 \
  --system-extension-image ghcr.io/siderolabs/kata-containers:3.24.0 \
  --system-extension-image ghcr.io/siderolabs/glibc:2.41 \
  --system-extension-image ghcr.io/siderolabs/tailscale:1.92.3 \
  --system-extension-image registry.ide-newton.ts.net/lab/firecracker:v1.12.1 \
  --output /out \
  --output-kind installer
```

Decompress and push the output tarball:

```bash
zstd -d /tmp/imager-out/installer-amd64.tar.zst -o /tmp/imager-out/installer-amd64.tar
crane push /tmp/imager-out/installer-amd64.tar registry.ide-newton.ts.net/lab/metal-installer-firecracker:v1.12.1
crane digest registry.ide-newton.ts.net/lab/metal-installer-firecracker:v1.12.1
```

The Firecracker upgrade should happen **after** the initial Cloud Hypervisor
install (i.e., after `siderolabs/kata-containers` is already active).

### 4) Ensure blockfile snapshotter + kata-fc runtime

The repo already includes a Talos patch:

- `devices/ryzen/manifests/kata-firecracker.patch.yaml`

It:

- Enables the blockfile snapshotter in `/etc/cri/containerd.toml`
- Configures blockfile settings in `/etc/cri/conf.d/20-customization.part`
- Defines the `kata-fc` runtime and points `ConfigPath` to
  `/usr/local/share/kata-containers/configuration.toml`

If you change the config path for Firecracker, update this file accordingly.

Apply via Talos config (controlplane + worker), then reboot for containerd to
reload its configuration.

### 5) Upgrade node(s)

- Update `devices/ryzen/manifests/installer-image.patch.yaml` to point at the
  new internal installer image digest.
- Upgrade the node(s) with the new installer image.
- Validate binaries exist:
  - `/usr/local/bin/firecracker`
  - `/usr/local/bin/jailer`

### 6) Validate runtime behavior

1) RuntimeClass exists:

```bash
kubectl --context=ryzen get runtimeclass
```

2) Run the Firecracker test pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kata-fc-test
  namespace: default
spec:
  runtimeClassName: kata-fc
  restartPolicy: Never
  containers:
    - name: busybox
      image: busybox:1.36
      command: ["sh", "-c", "echo kata-fc-ok && sleep 3600"]
```

3) Validate Firecracker is actually running:

- Talos host process list should show `firecracker --id ...`.
- Socket should exist under `/run/vc/firecracker/.../root/run/firecracker.socket`.

### 7) Troubleshooting

If pod sandbox creation fails with content-digest errors (pause image), run the
one-shot Job:

- `argocd/applications/kata-containers/pause-image-reset-job.yaml`

Then sync the kata-containers app via Argo CD.

## Change checklist (production)

- [ ] Firecracker extension image built and published.
- [ ] Custom installer image built via `imager` and pushed to internal registry.
- [ ] `devices/ryzen/manifests/installer-image.patch.yaml` updated to new digest.
- [ ] Talos upgrade completed.
- [ ] `kata-fc` runtime config points at Firecracker config.
- [ ] Test pod starts and Firecracker process/socket present.

## References (local clones)

- System extensions layout + boot asset composition:
  `~/github.com/extensions/README.md`
- Official kata-containers extension defaults to cloud-hypervisor:
  `~/github.com/extensions/container-runtime/kata-containers/configuration.toml`
- Firecracker install + block-device requirement in Kata:
  `~/github.com/kata-containers/docs/how-to/how-to-use-kata-containers-with-firecracker.md`
- Supported Firecracker version (Kata pin):
  `~/github.com/kata-containers/versions.yaml`
- Firecracker file-backed block devices + jailer:
  `~/github.com/firecracker/README.md`
- containerd blockfile snapshotter (VM use case):
  `~/github.com/containerd/docs/snapshotters/blockfile.md`
- Image Factory schema supports only `officialExtensions`:
  `~/github.com/image-factory/docs/api.md`,
  `~/github.com/image-factory/pkg/schematic/schematic.go`
- Default Talos imager image reference:
  `~/github.com/talos/pkg/images/images.go`
