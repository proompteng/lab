# kube-router NetworkPolicy controller

This manual Argo CD application runs kube-router v2.12.0 only as a Kubernetes NetworkPolicy controller. Flannel remains
the CNI and kube-proxy remains the nftables service proxy. Routing, service proxying, load-balancer allocation, CNI
installation, and IPv6 are explicitly disabled.

The image is pinned to the multi-architecture index
`sha256:e1da38f71e2f1521e7a74c5cdaa511fdee9d2ee76972b25c9b5785b030b96fe4`. Its expected Linux platform manifests are:

- amd64: `sha256:29034446e59a9e984a8a720c03f2ba1ce4e61ebb938d1a88c8f40b08bdb06c78`
- arm64: `sha256:c9b534a88b5a09abe452ba5a20d528e106c640416de95f4e9b6cc308fd24c54a`

## Activation safety

The application is manual. Sync wave `-3` retains rollout allow-all policies in agents, argocd, bilig, kafka, media,
pgadmin, synthesis and torghut. The Agents policy excludes the catalog sync pod so its own allowlist takes effect.
Bayn retains an inert policy whose selector must match no Pods.
Hermes, optional Tengri and Relay, and the reviewed policy sets listed in the rollout runbook keep their restrictive
policies enforced. Those namespaces receive no allow-all policy during activation.

The bounded wave `-2` hook validates the complete live namespace set, each retained safety policy and the
exact source-derived fingerprints of all enforced policy sets. Any mismatch stops the sync before the
DaemonSet is applied at wave `0`. CI validates the same fingerprints whenever their source files change.

The safety policies use `Prune=false`. Do not remove them as part of controller activation or rollback. Replace them only
through namespace-specific policy tests that prove all required ingress and egress before enforcement.

Follow [the production rollout runbook](../../../docs/runbooks/kube-router-network-policy-rollout.md) for activation,
live enforcement proof, workload comparison, and cleanup. The emergency cleanup overlay is intentionally excluded from
the production kustomization.

The completed PostgreSQL and ClickHouse upgrade test namespaces are retired.
Their fixture manifests remain in Git, but the live coverage gate no longer
requires those namespaces or their policies.
