# NUC Image Factory

This directory runs the community Sidero Labs Image Factory `v1.5.0` on the NUC. Omni uses it as the primary factory
for per-machine Talos schematics. The factory is reachable only on the Elauwit provider LAN at
`http://100.100.244.148:8081`; port `8080` remains owned by Pi-hole, and the backing OCI registry is private to the
Compose network.

The factory replaces the upstream extension catalog with the signed combined catalog published by
`.github/workflows/kata-firecracker-extension.yaml` at `ghcr.io/proompteng/talos-extensions:v1.13.9`. That catalog
contains every official Sidero Labs extension plus `proompteng/talos-kata-runtimes`. This is the supported community
path: the separate `enterprise.extraExtensions` feature is not required.

## Trust and persistent state

Input image verification stays enabled. The factory accepts only:

- Sidero Labs release identities issued by Google; and
- the `proompteng/lab` Kata workflow on `refs/heads/main`, issued by GitHub Actions OIDC.

The generated ECDSA key signs cached assets and custom installers. It lives at
`/var/lib/image-factory/secrets/cache-signing-key.key`, mode `0600`, and must be included in encrypted NUC backups.
The local registry and Image Factory temporary build storage also live below `/var/lib/image-factory`.

## Bootstrap and deploy

Run from the NUC checkout/copy of this directory:

```bash
cp .env.example .env
./bootstrap.sh
```

`bootstrap.sh` is idempotent: it creates the persistent directories and signing key once, validates that the NUC owns
`100.100.244.148/25`, pulls the digest-pinned images, starts both services, and verifies the signed Kata catalog.

Only after `verify.sh` passes, deploy the updated `devices/nuc/omni/omni.yaml` and restart the Omni container. Confirm
that Omni reports `http://100.100.244.148:8081/` as its primary Image Factory before changing any machine extensions.

Routine commands:

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 100 image-factory
./validate.sh
./verify.sh
```

## Omni handoff

The installer registry is HTTP on a private LAN. Before changing a schematic, apply this Talos config document to all
three machines through the exported Omni cluster template and wait until every pending config update has completed:

```yaml
apiVersion: v1alpha1
kind: RegistryMirrorConfig
name: 100.100.244.148:8081
endpoints:
  - url: http://100.100.244.148:8081
skipFallback: true
```

The exact Talos `v1.13.9` lifecycle path validates installer images with the system-containerd registry resolver, and
that resolver consumes `RegistryMirrorConfig`. The explicit `http://` endpoint is therefore used for both Talos-owned
installer pulls and CRI pulls. Without this mirror, an image reference such as
`100.100.244.148:8081/metal-installer/...` defaults to HTTPS and fails against this factory.

Then add `proompteng/talos-kata-runtimes` to each machine's `systemExtensions`, preserving its existing extensions:

| Machine                                        | Required extension set                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ryzen / `ff115a00-c307-11f0-a28f-648eab3e4100` | `siderolabs/amdgpu`, `siderolabs/amd-ucode`, `siderolabs/glibc`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes`                            |
| Turin / `8bf7ec00-171c-11f1-8000-7cc255f16774` | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |
| Altra / `12345678-9abc-deff-1234-56789abcdeff` | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |

The control-plane machine-set upgrade strategy must remain rolling with `maxParallelism: 1`. Change and sync only one
machine's extension list per phase in the fixed Ryzen, Turin, Altra order; do not lock the cluster or unrelated
machines. Omni then generates a different schematic only for the current target. Start the next phase only after the
Kubernetes, etcd, Ceph, and drain gates in the Galactic runbook pass again.
