# altra (Talos node)

This directory contains a reproducible runbook and patches for the `altra` node.

Inventory:

- Node: `altra` (`192.168.1.85`)
- Joined cluster: `ryzen` (kubeconfig context: `galactic`)
- Kubernetes API endpoint (behind the NUC LB): `https://nuc:6443` (also `https://192.168.1.130:6443`)
- Install disk: `/dev/nvme0n1`

Docs:

- `devices/altra/docs/cluster-bootstrap.md` (install + join existing cluster)
- `devices/altra/docs/relayout-volumes.md` (EPHEMERAL=300GB, local-path on OS disk + extra local-path on second NVMe)
- `docs/incidents/2026-02-18-altra-volume-relayout-etcd-rejoin.md` (failure modes, root causes, and recovery sequence from this session)

Related:

- NUC load balancer config: `devices/nuc/k8s-api-lb/README.md`
- Cluster inventory + canonical join procedure: `devices/galactic/README.md`
