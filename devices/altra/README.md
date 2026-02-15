# altra (3-node Talos cluster)

This directory contains reproducible runbooks and patches for the `altra` Talos/Kubernetes
cluster.

Defaults used by these docs:
- Kubernetes API endpoint (behind the NUC LB): `https://192.168.1.130:6444`
- Kubeconfig context name: `altra`

Docs:
- `devices/altra/docs/cluster-bootstrap.md`

Related:
- NUC load balancer template: `devices/nuc/k8s-api-lb-altra/README.md`

