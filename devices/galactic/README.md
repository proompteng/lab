# galactic cluster (ryzen)

This directory documents the existing Talos/Kubernetes cluster:

- **Talos cluster name**: `ryzen`
- **kubectl context name**: `galactic`
- **Kubernetes API endpoint** (behind NUC HAProxy): `https://nuc:6443` (also `https://192.168.1.130:6443`)

Inventory:

- `ryzen`: `192.168.1.194` (control plane)
- `ampone`: `192.168.1.203` (control plane)
- `altra`: `192.168.1.85` (control plane)

Runbooks:

- `devices/galactic/docs/add-control-plane-node.md`
- `devices/galactic/docs/bootstrap-argocd.md`
- `devices/galactic/docs/troubleshooting-networking.md`
- `devices/galactic/docs/tailscale.md`

Related:

- NUC HAProxy config: `devices/nuc/k8s-api-lb/README.md`
- Ryzen bootstrap: `devices/ryzen/docs/cluster-bootstrap.md`
- Ampone join: `devices/ampone/docs/cluster-bootstrap.md`
- Altra join: `devices/altra/docs/cluster-bootstrap.md`
- Ingress controller (Traefik): `argocd/applications/traefik`

## Tailscale

We run Tailscale on the Talos nodes via `ExtensionServiceConfig` (one per node):

- Templates live in `devices/*/manifests/tailscale-extension-service.template.yaml`.
- Rendered files (containing the auth key) are gitignored:
  - `devices/*/manifests/tailscale-extension-service.yaml`

Runbook:

- `devices/galactic/docs/tailscale.md`
