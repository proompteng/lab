# Production Plan: Firecracker on Talos (Ryzen)

This document is the production-grade plan to enable **Firecracker** as the VMM
for Kata Containers on the Talos `ryzen` cluster. It avoids ad-hoc host changes
and follows the Talos system extension model.

## Why this plan

- Talos rootfs is immutable. Host binaries (like `firecracker` and `jailer`) must
  be delivered via **system extensions** and activated at **install/upgrade**
  time.
- The **official** Talos `kata-containers` extension bundles **cloud-hypervisor**
  only. Firecracker is not included.
- Firecracker requires a **block-backed rootfs**. On Talos, the supported path is
  the **containerd blockfile snapshotter**, which is shipped but **disabled** by
  default.

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

Use the `siderolabs/extensions` repo as the reference implementation.
The official `kata-containers` extension is in:

- `~/github.com/extensions/container-runtime/kata-containers/pkg.yaml`

Create a new extension (example name: `container-runtime/firecracker`) that:

- Downloads Firecracker **release binaries** for the target arch (amd64).
- Installs `firecracker` and `jailer` into `/usr/local/bin`.
- Installs a Firecracker-oriented `configuration.toml` into
  `/usr/local/share/kata-containers/` (or another path you control).

Notes:

- Pin the Firecracker version explicitly (tag or checksum).
- If you install the config at a new path, update `ConfigPath` in the Talos
  containerd runtime config to point at it.
- Keep the official `kata-containers` extension for the kata runtime + guest
  assets; the Firecracker extension adds only the VMM bits.

### 2) Build and publish the extension image

Publish the extension image to a registry accessible by Talos Image Factory,
and record the **digest** for reproducible builds.

### 3) Update Talos Image Factory schematic

Include:

```yaml
customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/kata-containers
      - siderolabs/glibc
    extensionImages:
      - ghcr.io/<org>/talos-firecracker@sha256:<digest>
```

Extensions only take effect at install/upgrade time. Plan for a node upgrade.

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

- Generate the new Talos installer image with Image Factory.
- Upgrade the node(s).
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
- [ ] Image Factory schematic updated with extension image digest.
- [ ] Talos upgrade completed.
- [ ] `kata-fc` runtime config points at Firecracker config.
- [ ] Test pod starts and Firecracker process/socket present.

## External validation (upstream docs)

This plan is aligned with upstream guidance:

- Talos system extensions are only activated during **install/upgrade**, which is
  why Firecracker must be delivered via a custom extension and applied via an
  upgrade. citeturn0search2
- Image Factory schematics are the supported way to include system extensions in
  installer images, and custom extension images are explicitly supported. citeturn0search0turn0search4
- Firecracker requires **block-backed** storage; using a blockfile snapshotter on
  Talos satisfies that requirement. citeturn0search5
