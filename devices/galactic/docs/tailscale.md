# Tailscale on Talos nodes (production runbook)

This runbook installs and validates node-level Tailscale on Talos so `containerd` can pull private images from `registry.ide-newton.ts.net`.

Cluster inventory (current):
- `ryzen` (amd64): `192.168.1.194`
- `ampone` (arm64): `192.168.1.203`
- `altra` (arm64): `192.168.1.85`

## Why this is required

Kubernetes pulls images via node `kubelet`/`containerd`, not pod networking. If the node OS cannot reach a Tailscale-only registry hostname, pods fail with `ErrImagePull`/`ImagePullBackOff`.

## Architecture

Tailscale on Talos requires both:
1. Talos **system extension** (`tailscale`) in `machine.install.extensions`.
2. `ExtensionServiceConfig` named `tailscale` with runtime env (`TS_AUTHKEY`, `TS_HOSTNAME`, routes, etc.).

Important DNS behavior on Talos:
- Set `TS_ACCEPT_DNS=false`.
- Configure DNS using Talos machine config (`machine.network.nameservers`).
- Reason: Talos root filesystem is immutable; allowing Tailscale to manage `/etc/resolv.conf` creates noisy failures.

## Files in this repo

- Extension patch:
  - `devices/ryzen/manifests/tailscale-system-extension.patch.yaml`
  - `devices/ampone/manifests/tailscale-system-extension.patch.yaml`
  - `devices/altra/manifests/tailscale-system-extension.patch.yaml`
- DNS patch:
  - `devices/ryzen/manifests/tailscale-dns.patch.yaml`
  - `devices/ampone/manifests/tailscale-dns.patch.yaml`
  - `devices/altra/manifests/tailscale-dns.patch.yaml`
- Service template:
  - `devices/ryzen/manifests/tailscale-extension-service.template.yaml`
  - `devices/ampone/manifests/tailscale-extension-service.template.yaml`
  - `devices/altra/manifests/tailscale-extension-service.template.yaml`
- Generated (gitignored, contains authkey):
  - `devices/*/manifests/tailscale-extension-service.yaml`

## 1) Render per-node ExtensionServiceConfig files

```bash
bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
bun run packages/scripts/src/tailscale/generate-ampone-extension-service.ts
bun run packages/scripts/src/tailscale/generate-altra-extension-service.ts
```

## 2) Patch machine config (no reboot yet)

```bash
# ryzen (192.168.1.194)
talosctl get machineconfig -n 192.168.1.194 -e 192.168.1.194 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/ryzen-machineconfig.yaml
talosctl apply-config -n 192.168.1.194 -e 192.168.1.194 -f /tmp/ryzen-machineconfig.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot

# ampone (192.168.1.203)
talosctl get machineconfig -n 192.168.1.203 -e 192.168.1.203 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/ampone-machineconfig.yaml
talosctl apply-config -n 192.168.1.203 -e 192.168.1.203 -f /tmp/ampone-machineconfig.yaml \
  --config-patch @devices/ampone/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/ampone/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/ampone/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot

# altra (192.168.1.85)
talosctl get machineconfig -n 192.168.1.85 -e 192.168.1.85 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/altra-machineconfig.yaml
talosctl apply-config -n 192.168.1.85 -e 192.168.1.85 -f /tmp/altra-machineconfig.yaml \
  --config-patch @devices/altra/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/altra/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/altra/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot
```

## 3) Activate extension on boot

### Method A (recommended for arm64 boards): ESP UKI swap

Use this on `ampone` and `altra`. This avoids firmware `efivars` write failures observed on ARM boards during in-place `talosctl upgrade`.

1. Create a schematic with `siderolabs/tailscale`.
2. Download arm64 secureboot ISO for that schematic:

```bash
SCHEMATIC_ID='<your-schematic-id>'
TALOS_VER='v1.12.4'
curl -L -o /tmp/metal-arm64-secureboot.iso \
  "https://factory.talos.dev/image/${SCHEMATIC_ID}/${TALOS_VER}/metal-arm64-secureboot.iso"
```

3. Extract UKI from the ISO:

```bash
tmpdir="$(mktemp -d)"
bsdtar -xf /tmp/metal-arm64-secureboot.iso -C "$tmpdir"
ls -la "$tmpdir/EFI/Linux"
cp "$tmpdir/EFI/Linux/Talos-v1.12.4.efi" /tmp/Talos-v1.12.4.efi
```

4. Mount ESP from the target node and replace UKI (example: ampone):

```bash
kubectl -n kube-system delete pod efi-tools-203 --ignore-not-found
kubectl -n kube-system run efi-tools-203 \
  --image=debian:12-slim \
  --restart=Never \
  --overrides='{"spec":{"nodeName":"talos-192-168-1-203","hostPID":true,"containers":[{"name":"efi","image":"debian:12-slim","command":["sleep","infinity"],"securityContext":{"privileged":true},"volumeMounts":[{"name":"hostdev","mountPath":"/dev"}]}],"volumes":[{"name":"hostdev","hostPath":{"path":"/dev"}}]}}'
kubectl -n kube-system wait --for=condition=Ready pod/efi-tools-203 --timeout=60s
kubectl -n kube-system cp /tmp/Talos-v1.12.4.efi efi-tools-203:/tmp/Talos-v1.12.4.efi
kubectl -n kube-system exec efi-tools-203 -- bash -lc '
  set -euxo pipefail
  apt-get update
  apt-get install -y mount util-linux
  mkdir -p /mnt/efi
  mount /dev/nvme0n1p1 /mnt/efi
  ls -la /mnt/efi/EFI/Linux
  cp /mnt/efi/EFI/Linux/Talos-v1.12.4.efi /mnt/efi/EFI/Linux/Talos-v1.12.4.efi.bak.$(date +%s)
  cp /tmp/Talos-v1.12.4.efi /mnt/efi/EFI/Linux/Talos-v1.12.4.efi
  # Prevent duplicate boot menu entries from extra UKIs:
  [ -f /mnt/efi/EFI/Linux/Talos-v1.12.4~1.efi ] && mv /mnt/efi/EFI/Linux/Talos-v1.12.4~1.efi /mnt/efi/EFI/Linux/Talos-v1.12.4~1.efi.disabled.$(date +%s) || true
  sync
  umount /mnt/efi
'
kubectl -n kube-system delete pod efi-tools-203
talosctl -n 192.168.1.203 reboot
```

Repeat for `altra` using its node name and ESP device.

### Method B (standard): Talos in-place upgrade

Use when firmware supports bootloader updates reliably:

```bash
talosctl upgrade -n 192.168.1.194 -e 192.168.1.194 --image ghcr.io/siderolabs/installer:v1.12.4
```

## 4) Validation checklist

Run per node:

```bash
talosctl -n <node-ip> get extensions | rg tailscale
talosctl -n <node-ip> service ext-tailscale status
talosctl -n <node-ip> logs ext-tailscale | tail -n 40
```

Confirm node appears in Tailnet:

```bash
tailscale status | rg -E 'ryzen|ampone|altra'
```

Confirm node-level private pull:

```bash
talosctl image pull -n <node-ip> -e <node-ip> registry.ide-newton.ts.net/lab/registry-smoketest:<tag>
```

## Failure modes and fixes (observed)

1. `failed to install bootloader ... efivars ... input/output error` on ARM:
- Cause: firmware/efivars write path fails during in-place upgrade.
- Fix: use Method A (ESP UKI swap), then reboot.

2. Boot menu shows many Talos entries:
- Cause: multiple `.efi` UKIs under `EFI/Linux`; systemd-boot auto-discovers each.
- Fix: keep one active UKI (`Talos-v1.12.4.efi`), rename extra files (for example `~1.efi`).

3. `ext-tailscale` never stabilizes or node missing in Tailnet:
- Cause: missing extension activation, bad `TS_AUTHKEY`, or wrong tags/ACL.
- Fix: verify `get extensions`, verify `ExtensionServiceConfig`, rotate auth key, check tailnet ACL grants for tags.

4. `TS_ACCEPT_DNS=true` causes DNS write errors:
- Cause: Talos root FS is immutable.
- Fix: set `TS_ACCEPT_DNS=false`, manage nameservers via machine config patches.

5. Node identity/IP drift (`202` -> `203`) breaks cluster/LB:
- Cause: node rebooted with different live identity/IP while configs still reference old IP.
- Fix:
  - remove stale etcd member and stale Kubernetes node
  - update local talosconfig endpoints/nodes
  - update NUC HAProxy backend (`devices/nuc/k8s-api-lb/haproxy.cfg`) to new IP
  - update docs/manifests that still reference old IP

## Post-change cluster checks

```bash
kubectl get nodes -o wide
kubectl -n registry get pod -o wide
kubectl get pod -n default private-image-test-ampone -o jsonpath='{.status.phase}{"\n"}'
```
