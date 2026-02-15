# galactic cluster (ryzen)

This directory documents the existing Talos/Kubernetes cluster:

- **Talos cluster name**: `ryzen`
- **kubectl context name**: `galactic`
- **Kubernetes API endpoint** (behind NUC HAProxy): `https://192.168.1.130:6443`

Inventory:
- `ryzen`: `192.168.1.194` (control plane)
- `ampone`: `192.168.1.202` (control plane)
- `altra`: `192.168.1.85` (control plane)

Runbooks:
- `devices/galactic/docs/add-control-plane-node.md`

Related:
- NUC HAProxy config: `devices/nuc/k8s-api-lb/README.md`
- Ryzen bootstrap: `devices/ryzen/docs/cluster-bootstrap.md`
- Ampone join: `devices/ampone/docs/cluster-bootstrap.md`
- Altra join: `devices/altra/docs/cluster-bootstrap.md`

