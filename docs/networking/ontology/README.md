# Galactic networking Auto Ontology knowledge

[Networking knowledge](networking-knowledge.json) is the version-1 seed for Galactic's networking glossary and
operational rules. The rules are advisory saved searches that apply catalog tags, not cluster policy enforcement.
`customAnalyses` is empty: the evidence is in runbooks and GitOps, not a PostgreSQL schema.

## Review the evidence

- **Pod capacity and IPAM:** The [/23 maintenance runbook](../../runbooks/galactic-turin-podcidr-23-migration-plan.md)
  distinguishes assigned PodCIDRs, usable addresses, and kubelet pod limits. The
  [recovery runbook](../../runbooks/galactic-storage-and-workload-recovery.md#phase-5-recover-host-local-ipam-exhaustion)
  owns the proof and lock procedure for exact orphan leases.
- **Flannel and service IPs:** The [network troubleshooting guide](../../../devices/galactic/docs/troubleshooting-networking.md)
  explains why fresh pod MTU, cross-node traffic, and MetalLB advertisement need separate checks. Review against the
  [Flannel ConfigMap](../../../argocd/applications/flannel-cni/kube-flannel-cfg.yaml) and
  [Galactic release procedure](../../../devices/galactic/releases/README.md#kubernetes-add-ons).
- **Tailnet paths:** The [node guide](../../../devices/galactic/docs/tailscale.md) covers Omni-managed extensions.
  The [Operator application](../../../argocd/applications/tailscale/) declares Connector routes and a CoreDNS
  forwarding snippet.
  The [Operator ingress guide](https://tailscale.com/docs/kubernetes-operator/ingress) distinguishes standalone
  proxies from shared proxy groups.
- **Ingress selection:** [Traefik](../../../argocd/applications/traefik/values.yaml) is the shared default class.
  [Knative](../../../argocd/applications/knative-serving/knative-serving.yaml) selects its own Istio gateways.
  [Buzz admin](../../runbooks/buzz-production.md#acceptance) is an example of a separate tailnet ingress with an
  independent access boundary.

Use each rule's source commit and verification note to review changes against the owning source. Acronym names
are global and compared case-insensitively by the sync. Before adding a term, compare it with the Agents, Bayn,
observability, CI, Galactic, security, and storage bundles, including companion PRs that are not yet merged.
Use shared terms such as Omni and Tailscale in rules without redefining them.

## Validate locally

From the repository root with Bun dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/networking/ontology/networking-knowledge.json --mode dry-run
bun run packages/scripts/src/agents/validate-ontology-bundles.ts
bun test packages/scripts/src/agents/
bunx oxfmt --check docs/networking/ontology/networking-knowledge.json docs/networking/ontology/README.md
bunx oxlint --config .oxlintrc.json packages/scripts/src/agents
```

Dry-run checks the bundle offline without credentials, HTTP requests, or writes. It does not verify live
networking or catalog state. Oxlint checks the TypeScript tooling, not the JSON or Markdown inputs.

## Publication boundary

Keep `dataSource` set to `network`. The sync derives `network canonical rule`, which is 22 characters, including
spaces. The [Auto Ontology 1.3.0 tag API](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/auto_ontology/server/tags/router.py#L120-L135)
rejects tag names longer than 25 characters with HTTP 400.

Any separately authorized publication must use the [reviewed sync procedure](../../agents/ontology/README.md#preview-and-publish)
and verify that the catalog has one onboarded database named `network` and the preconfigured canonical rule tag.
This bundle provisions neither and does not change the network.
