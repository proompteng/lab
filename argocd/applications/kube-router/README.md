# kube-router NetworkPolicy controller

This manual Argo CD application runs kube-router v2.11.1 only as a Kubernetes NetworkPolicy controller. Flannel remains
the CNI and kube-proxy remains the nftables service proxy. Routing, service proxying, load-balancer allocation, CNI
installation, and IPv6 are explicitly disabled.

The image is pinned to the multi-architecture index
`sha256:64da9a538d29e13780e256ce3897a52932a68657793bef009063bbeb2762146a`. Its expected Linux platform manifests are:

- amd64: `sha256:05d1c7c903721ac202ce261fff33f61526e55188dc2135cdc39b4bcd173960a2`
- arm64: `sha256:fec5ac13d36a812636d545263fda75e5b729ac9dac624f1f19f1170d3372324b`

## Activation safety

The application is manual. Sync wave `-3` installs temporary allow-all policies in every namespace that already has a
NetworkPolicy. A bounded wave `-2` hook compares that declared namespace set to the live cluster and validates every
safety policy. Any mismatch stops the sync before the DaemonSet is applied at wave `0`.

The safety policies use `Prune=false`. Do not remove them as part of controller activation or rollback. Replace them only
through namespace-specific policy tests that prove all required ingress and egress before enforcement.

Follow [the production rollout runbook](../../../docs/runbooks/kube-router-network-policy-rollout.md) for activation,
live enforcement proof, workload comparison, and cleanup. The emergency cleanup overlay is intentionally excluded from
the production kustomization.
