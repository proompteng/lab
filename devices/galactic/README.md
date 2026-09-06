# galactic cluster

This directory is the repository source for the existing three-node Talos/Kubernetes cluster managed by Omni:

- **Omni/Talos cluster name**: `galactic`
- **kubectl context**: `galactic-lan`
- **desired Talos**: `v1.13.9`
- **desired Kubernetes**: `v1.36.4`
- **Kubernetes API endpoint**: NUC HAProxy on `https://nuc:6443`

The Elauwit provider LAN uses the following Talos API addresses. These are local-network endpoints even though they
are in `100.100.244.0/24`; do not replace them with Tailscale addresses:

| Machine | Kubernetes node       | Architecture | Talos API         | Omni machine UUID                      |
| ------- | --------------------- | ------------ | ----------------- | -------------------------------------- |
| Ryzen   | `talos-192-168-1-194` | `amd64`      | `100.100.244.141` | `ff115a00-c307-11f0-a28f-648eab3e4100` |
| Turin   | `turin`               | `amd64`      | `100.100.244.190` | `8bf7ec00-171c-11f1-8000-7cc255f16774` |
| Altra   | `talos-192-168-1-85`  | `arm64`      | `100.100.244.142` | `12345678-9abc-deff-1234-56789abcdeff` |

Omni owns Talos machine configuration and OS/Kubernetes upgrades. Argo CD owns Kubernetes applications. Do not apply
routine machine configuration directly with `talosctl` after the Omni handoff.

Legacy Harvester, Rancher, and K3s assets remain in the working tree only while their external dependencies are verified.
They are not current cluster instructions; follow `docs/repository-cleanup-todo.md` for their bounded retirement work.

Runbooks:

- `devices/galactic/docs/add-control-plane-node.md`
- `devices/galactic/docs/bootstrap-argocd.md`
- `devices/galactic/docs/troubleshooting-networking.md`
- `devices/galactic/omni/README.md`
- `devices/galactic/docs/tailscale.md` (Omni-owned Tailscale validation)
- `docs/runbooks/talos-latest-upgrade-plan.md`
- `devices/galactic/extensions/kata/README.md`

Related:

- NUC HAProxy config: `devices/nuc/k8s-api-lb/README.md`
- Ryzen bootstrap: `devices/ryzen/docs/cluster-bootstrap.md`
- Ampone join: `devices/ampone/docs/cluster-bootstrap.md`
- Altra join: `devices/altra/docs/cluster-bootstrap.md`
- Ingress controller (Traefik): `argocd/applications/traefik`

## Tailscale

Omni owns the Tailscale system extension and per-machine `ExtensionServiceConfig` in
`devices/galactic/omni/cluster-template.yaml`. Follow `devices/galactic/omni/README.md` for secret-safe rendering,
validation, dry-run, and sync. Use `devices/galactic/docs/tailscale.md` for read-only runtime validation; do not apply
the retained per-device patches directly.
