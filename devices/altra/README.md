# altra (Talos node)

This directory contains a reproducible runbook and patches for the `altra` node.

Inventory:
- Node: `altra` (`192.168.1.85`)
- Joined cluster: `ryzen` (kubeconfig context: `galactic`)
- Kubernetes API endpoint (behind the NUC LB): `https://192.168.1.130:6443`
- Install disk: `/dev/nvme0n1`

Docs:
- `devices/altra/docs/cluster-bootstrap.md` (install + join existing cluster)

Related:
- NUC load balancer config: `devices/nuc/k8s-api-lb/README.md`
- Cluster inventory + canonical join procedure: `devices/galactic/README.md`
