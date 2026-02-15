# Tailscale on Talos nodes (ryzen, ampone, altra)

This cluster runs Tailscale on the Talos nodes using:

1. The **Tailscale system extension** (adds `tailscaled` to the Talos OS)
2. A per-node `ExtensionServiceConfig` (wires up auth + hostname + routes)

Why both:
- The `ExtensionServiceConfig` alone is not enough if the system extension is not present.
- System extensions only become active during **install/upgrade**.

## Why this is required for pulling images from `*.ts.net` registries

Kubernetes image pulls are performed by `kubelet`/`containerd` on the node OS. If the node cannot resolve or reach a Tailscale-only registry hostname, workloads will fail with `ImagePullBackOff` even if the pod network is healthy.

In this cluster:
1. The in-cluster registry is exposed via a Tailscale ingress hostname (`registry.ide-newton.ts.net`).
1. Nodes must run Tailscale so they can resolve and route to that hostname during image pulls.

## 0) Pick the extension image for your Talos version

For Talos `v1.12.4`, we pin the digest from the Sidero Labs extensions catalog:

```bash
crane export ghcr.io/siderolabs/extensions:v1.12.4 \
  | tar x -O image-digests \
  | rg '^ghcr.io/siderolabs/tailscale'
```

This repo currently pins:

```text
ghcr.io/siderolabs/tailscale:1.94.1@sha256:cd53cd514a7686babdea47ba4784a8c97cecec535003f4aa3d3e526689333a09
```

If you bump Talos versions, update the digest in:
- `devices/ryzen/manifests/tailscale-system-extension.patch.yaml`
- `devices/ampone/manifests/tailscale-system-extension.patch.yaml`
- `devices/altra/manifests/tailscale-system-extension.patch.yaml`

## 1) Generate per-node ExtensionServiceConfigs (auth key is gitignored)

These rendered files contain the auth key and are gitignored:
- `devices/ryzen/manifests/tailscale-extension-service.yaml`
- `devices/ampone/manifests/tailscale-extension-service.yaml`
- `devices/altra/manifests/tailscale-extension-service.yaml`

Generate them from templates (reads authkey from 1Password):

```bash
bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
bun run packages/scripts/src/tailscale/generate-ampone-extension-service.ts
bun run packages/scripts/src/tailscale/generate-altra-extension-service.ts
```

## 2) Apply config changes to each node (no reboot yet)

```bash
# ryzen
talosctl get machineconfig -n 192.168.1.194 -e 192.168.1.194 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/ryzen-machineconfig.yaml

talosctl apply-config -n 192.168.1.194 -e 192.168.1.194 -f /tmp/ryzen-machineconfig.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/ryzen/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot

# ampone
talosctl get machineconfig -n 192.168.1.202 -e 192.168.1.202 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/ampone-machineconfig.yaml

talosctl apply-config -n 192.168.1.202 -e 192.168.1.202 -f /tmp/ampone-machineconfig.yaml \
  --config-patch @devices/ampone/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/ampone/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/ampone/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot

# altra
talosctl get machineconfig -n 192.168.1.85 -e 192.168.1.85 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/altra-machineconfig.yaml

talosctl apply-config -n 192.168.1.85 -e 192.168.1.85 -f /tmp/altra-machineconfig.yaml \
  --config-patch @devices/altra/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/altra/manifests/tailscale-dns.patch.yaml \
  --config-patch @devices/altra/manifests/tailscale-system-extension.patch.yaml \
  --mode=no-reboot
```

## 3) Activate the system extension (upgrade; rolling)

System extensions become active on boot. Upgrade to the same Talos version is OK.

Do this one node at a time:

```bash
talosctl upgrade -n 192.168.1.85 -e 192.168.1.85 --image ghcr.io/siderolabs/installer:v1.12.4
talosctl upgrade -n 192.168.1.202 -e 192.168.1.202 --image ghcr.io/siderolabs/installer:v1.12.4
talosctl upgrade -n 192.168.1.194 -e 192.168.1.194 --image ghcr.io/siderolabs/installer:v1.12.4
```

## 4) Validate

After upgrade/reboot, verify the extension is installed:

```bash
talosctl get extensions -n 192.168.1.194 -e 192.168.1.194 | rg tailscale
```

Then validate an actual node-level image pull from the Tailscale registry hostname (this exercises `containerd` on the node):

```bash
export REGISTRY_SMOKETEST_IMAGE='registry.ide-newton.ts.net/lab/registry-smoketest:<tag>'
talosctl image pull -n 192.168.1.85 -e 192.168.1.85 "$REGISTRY_SMOKETEST_IMAGE"
```
