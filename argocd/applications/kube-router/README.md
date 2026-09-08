# kube-router NetworkPolicy controller

This manual Argo CD application runs kube-router v2.10.0 only as a Kubernetes NetworkPolicy controller. Flannel remains
the CNI and kube-proxy remains the nftables service proxy. Routing, service proxying, load-balancer allocation, CNI
installation, and IPv6 are explicitly disabled.

The image is pinned to the multi-architecture index
`sha256:0991f2cc7aaabe107b51c0c554d6b843f0483fd319b94f437fab638470c47c22`. Its expected Linux platform manifests are:

- amd64: `sha256:81619a698b981a5c4fd6c89ae015d0faadce5d7a5270df7562c1743e58e3283f`
- arm64: `sha256:b8df3247641d5f4e84e14d30b673b6362a0e3d56901218a1e1ee38a40f37afd8`

## Activation safety

The application is manual. Sync wave `-3` installs temporary allow-all policies in every namespace that already has a
NetworkPolicy. A bounded wave `-2` hook compares that declared namespace set to the live cluster and validates every
safety policy. Any mismatch stops the sync before the DaemonSet is applied at wave `0`.

The safety policies use `Prune=false`. Do not remove them as part of controller activation or rollback. Replace them only
through namespace-specific policy tests that prove all required ingress and egress before enforcement.

Follow [the production rollout runbook](../../../docs/runbooks/kube-router-network-policy-rollout.md) for activation,
live enforcement proof, workload comparison, and cleanup. The emergency cleanup overlay is intentionally excluded from
the production kustomization.
