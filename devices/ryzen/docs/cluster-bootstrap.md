# Ryzen Talos bootstrap (USB install)

This runbook is for the Ryzen Talos node booted from USB at `192.168.1.194`.
It keeps the setup reproducible by using the patches in `devices/ryzen/manifests`
plus the existing Talos/KubeVirt docs in this repo.

Cluster inventory / current state:
- `devices/galactic/README.md`

## Manifest inventory (ryzen)

Node-level patches:
- `devices/ryzen/manifests/ephemeral-volume.patch.yaml` (limit system disk to 200GB)
- `devices/ryzen/manifests/local-path.patch.yaml` (user volume for local-path, grows to consume remaining system disk space)
- `devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml` (allow workloads on single-node controlplane)
- `devices/ryzen/manifests/hostname.patch.yaml` (set Talos hostname to `ryzen`, optional if the generated config already sets it)
- `devices/ryzen/manifests/node-labels.patch.yaml` (labels for KubeVirt scheduling)
- `devices/ryzen/manifests/tailscale-extension-service.template.yaml` (Tailscale extension service template)
- `devices/ryzen/manifests/tailscale-extension-service.yaml` (generated from template; gitignored)
- `devices/ryzen/manifests/tailscale-dns.patch.yaml` (prefer MagicDNS for tailnet hostnames)
- `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml` (Image Factory schematic: tailscale + AMD GPU + kernel args)

Related docs:
- `devices/ryzen/docs/amdgpu-device-plugin.md`
- `devices/ryzen/docs/bosgame-m5-talos-drivers.md`
- `devices/ryzen/docs/node-level-dependencies.md`
- `devices/ryzen/docs/relayout-volumes.md` (re-layout EPHEMERAL + local-path on an existing install)
- `docs/kubevirt/workers-ryzen.md`

## 1) Generate Talos config (store in `devices/ryzen/`)

These files are gitignored on purpose:
- `devices/ryzen/controlplane.yaml`
- `devices/ryzen/worker.yaml`
- `devices/ryzen/talosconfig`

Generate configs with the cluster endpoint. For this lab, the endpoint is the
NUC HAProxy load balancer on the LAN:

- `devices/nuc/k8s-api-lb/README.md`

Confirm the install disk (likely `/dev/nvme0n1` on the 2TB NVMe) before running.

```bash
# Example using the NUC load balancer endpoint.

export TALOSCONFIG=$PWD/devices/ryzen/talosconfig
export K8S_LB_ENDPOINT='nuc' # or '192.168.1.130'

talosctl gen config ryzen "https://$K8S_LB_ENDPOINT:6443" \
  --output-dir devices/ryzen \
  --install-disk /dev/nvme0n1
```

## 2) Apply disk layout + node patches

Talos only applies volume sizing at install time. Make sure these patches are
in place before the first `apply-config` / install.

### 2.1 System disk size (200GB)

The EPHEMERAL volume is capped at 200GB with this patch:

- `devices/ryzen/manifests/ephemeral-volume.patch.yaml`

### 2.2 User volume for local-path

The local-path provisioner uses a `local-path-provisioner` Talos user volume mounted at
`/var/mnt/local-path-provisioner`.

This repo configures it to **grow** and consume the remaining free space on the system
disk (after EFI/META/STATE and the 200GB EPHEMERAL volume), rather than hardcoding a
fixed size:

- `devices/ryzen/manifests/local-path.patch.yaml`

If you need to re-layout these volumes on an already-installed node, follow:

- `devices/ryzen/docs/relayout-volumes.md`

### 2.4 Optional patches

- `devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml` (single-node)
- `devices/ryzen/manifests/hostname.patch.yaml`
- `devices/ryzen/manifests/node-labels.patch.yaml`
- `devices/ryzen/manifests/tailscale-extension-service.yaml` (generate via `bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts`)
- `devices/ryzen/manifests/tailscale-dns.patch.yaml`

Image Factory schematic (boot assets, not a config patch):
- `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml` (tailscale + AMD GPU + kernel args)

### 2.4.1 Generate the Tailscale extension service patch

The Tailscale auth key is stored in 1Password and should not be committed. Generate
the patch from the template (output is gitignored):

```bash
bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
```

To override the 1Password path:

```bash
RYZEN_TAILSCALE_AUTHKEY_OP_PATH='op://infra/tailscale auth key/authkey' \\
  bun run packages/scripts/src/tailscale/generate-ryzen-extension-service.ts
```

### 2.5 Apply config with patches

Use config patches so the generated files stay clean and reproducible:

```bash
export TALOSCONFIG=$PWD/devices/ryzen/talosconfig

# First install from maintenance mode (USB boot)
talosctl apply-config --insecure -n 192.168.1.194 -e 192.168.1.194 \
  -f devices/ryzen/controlplane.yaml \
  --config-patch @devices/ryzen/manifests/ephemeral-volume.patch.yaml \
  --config-patch @devices/ryzen/manifests/local-path.patch.yaml

# Optional patches you can add at install time:
#   --config-patch @devices/ryzen/manifests/allow-scheduling-controlplane.patch.yaml
#   --config-patch @devices/ryzen/manifests/hostname.patch.yaml
#   --config-patch @devices/ryzen/manifests/node-labels.patch.yaml
#   --config-patch @devices/ryzen/manifests/tailscale-extension-service.yaml
#   --config-patch @devices/ryzen/manifests/tailscale-dns.patch.yaml
```

## 2.6 System extensions (Image Factory)

The Ryzen Talos node uses Image Factory to embed the required system extensions and
kernel args (Tailscale + AMD GPU support). The schematic is tracked in-repo:

- `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml`

Create a schematic ID, then upgrade Talos to activate extensions:

```bash
SCHEMATIC_ID="$(
  curl -sS -X POST --data-binary @devices/ryzen/manifests/ryzen-tailscale-schematic.yaml \
    https://factory.talos.dev/schematics | jq -r .id
)"

cat > /tmp/ryzen-installer-image.patch.yaml <<EOF
machine:
  install:
    image: factory.talos.dev/metal-installer/${SCHEMATIC_ID}:v1.12.4
EOF

talosctl patch mc -n 192.168.1.194 -e 192.168.1.194 \
  --patch @/tmp/ryzen-installer-image.patch.yaml \
  --mode=no-reboot

talosctl upgrade -n 192.168.1.194 -e 192.168.1.194 \
  --image factory.talos.dev/metal-installer/${SCHEMATIC_ID}:v1.12.4

talosctl get extensions -n 192.168.1.194
```

Notes:
- Extensions only activate during install/upgrade.
- See `devices/ryzen/docs/relayout-volumes.md` for the operational runbook when
  re-laying out `EPHEMERAL` + `local-path-provisioner` on an existing install.

## 3) Bootstrap the cluster

For a brand new controlplane, run the bootstrap step once:

```bash
talosctl bootstrap -n 192.168.1.194
```

Wait for Kubernetes API to become available, then merge kubeconfig.

```bash
talosctl kubeconfig -n 192.168.1.194 -e 192.168.1.194 \
  --force \
  --force-context-name galactic \
  ~/.kube/config
```

### 3.1 Kubeconfig context name (ensure it is `galactic`)

The Talos-generated kubeconfig can create the context as `admin@ryzen`.
We want the context name to be exactly `galactic`.

```bash
# If Talos created admin@ryzen, rename it to galactic
kubectl config rename-context admin@ryzen galactic || true

# Ensure the active context is galactic
kubectl config use-context galactic
kubectl config get-contexts
```

Capture the live Talos config for audit/repro:

```bash
talosctl -n 192.168.1.194 -e 192.168.1.194 get machineconfig -o yaml > devices/ryzen/node-machineconfig.yaml
```

## 4) KubeVirt

KubeVirt is installed via Argo CD.

Runbook:
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
- `argocd/applicationsets/platform.yaml`: `kubevirt`, `cdi`, `workers`

When the cluster is registered, these ApplicationSets should render the
`*-ryzen` Applications automatically.
