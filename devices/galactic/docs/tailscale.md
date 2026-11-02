# Tailscale on Galactic Talos nodes

Status: Current validation guide. Omni owns configuration and rollout.

Node-level Tailscale lets Talos `kubelet` and `containerd` reach private tailnet services such as
`registry.ide-newton.ts.net`. The authoritative desired state is the secret-redacted Omni template at
`devices/galactic/omni/cluster-template.yaml`, which declares the `siderolabs/tailscale` system extension and one
`ExtensionServiceConfig` per machine.

## Change path

Follow `devices/galactic/omni/README.md` to render the template with secrets into a mode-`0600` temporary file, validate
it, inspect an Omni dry-run, and sync one machine phase at a time. Never commit the raw export, rendered template,
Tailscale auth key, or Omni join token.

Do not apply the retained per-device Tailscale patches with `talosctl apply-config`, manually replace an EFI image, or
force a Talos upgrade to change Tailscale. Those were pre-Omni recovery paths and no longer own `galactic` machine
configuration. Use `docs/runbooks/talos-latest-upgrade-plan.md` for the bounded same-schematic replacement exception.

## Repository validation

Before proposing an Omni template change:

```bash
bun test devices/galactic/omni/render-template.test.ts
```

Then follow the render, `omnictl cluster template validate`, and `omnictl cluster template sync --dry-run --verbose`
sequence in `devices/galactic/omni/README.md`. A dry-run is required before an explicitly approved sync.

## Runtime validation

Use the current machine addresses from `devices/galactic/README.md`. Run these read-only checks for each target node:

```bash
talosctl -n <talos-api-address> -e <talos-api-address> get extensions | rg tailscale
talosctl -n <talos-api-address> -e <talos-api-address> service ext-tailscale status
talosctl -n <talos-api-address> -e <talos-api-address> logs ext-tailscale | tail -n 40
```

Confirm all three current nodes are online and reachable through the tailnet:

```bash
set -euo pipefail

for node in ryzen turin altra; do
  if ! tailscale ping --c 1 --timeout 10s --until-direct=false "$node" >/dev/null; then
    printf 'required Tailscale node is offline or unreachable: %s\n' "$node" >&2
    exit 1
  fi
done
```

When validating private registry reachability, use an existing approved smoke-test tag and pull it through the Talos
node runtime:

```bash
talosctl -n <talos-api-address> -e <talos-api-address> image pull \
  registry.ide-newton.ts.net/lab/registry-smoketest:<approved-tag>
```

Do not create or publish a new image merely to perform this check.

## Acceptance

- Omni reports no unexpected pending machine operation.
- The expected Tailscale extension is installed and `ext-tailscale` is healthy on each node.
- Ryzen, Turin, and Altra have the intended tailnet identities and answer a Tailscale-layer ping.
- A node-level private registry pull succeeds without changing DNS or machine configuration directly.
- Kubernetes nodes remain `Ready`, and existing registry-backed workloads do not enter `ImagePullBackOff`.

An Omni sync completing is configuration evidence, not runtime acceptance. Record the exact target machine and readback
evidence before moving to another node.
