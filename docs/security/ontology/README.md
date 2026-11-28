# Galactic security Auto Ontology knowledge

[Security and RBAC knowledge](security-rbac-knowledge.json) is the version-1 Git source for Galactic's
Kubernetes access, workload identity, secret-sync, and Tailscale contracts. The catalog rules are
advisory, not enforcement policy. The bundle includes no SQL (`customAnalyses: []`) or credentials and
does not provision a catalog database, publish entries, or change access.

## Review against the source contracts

- [Repository operating rules](../../../AGENTS.md) and the [Agents RBAC matrix](../../agents/rbac-matrix.md):
  confirm context and identity, prefer namespace-scoped grants, allowlist Secret reads, and keep verification
  evidence free of credentials. [Hermes RBAC](../../../argocd/applications/hermes/rbac.yaml) shows a cluster
  reader with explicit core resources that exclude Secrets, token creation, and interactive Pod subresources.
- [Agents workload identity](../../agents/auto-ontology-mcp.md) and its
  [verifier](../../../services/agents/src/auto-ontology-mcp/identity.ts): use a projected, audience-bound
  token and deny requests when the review, service account, or live workload binding fails verification.
  The [Agents ontology guide](../../agents/ontology/README.md) documents the separate read-only database role.
- [Galactic access and resealing](../../runbooks/galactic-kubernetes-access.md),
  [External Secrets](../../../argocd/applications/external-secrets/README.md), and
  [Tailscale policy](../../../tofu/tailscale/README.md): preserve the owning Secret source, verify without
  exposing values, and keep tailnet reachability separate from Kubernetes authorization.

## Catalog identity

Keep `dataSource` set to `security`. Its derived tag, `security canonical rule`, is 23 characters;
[Auto Ontology 1.3.0](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/auto_ontology/server/tags/router.py#L120-L136)
rejects tag names longer than 25 characters with HTTP 400.

Acronym names are global and matched case-insensitively. Check new names against the Agents, Bayn,
observability, CI/release, and Wave 19I platform bundles. The
[Wave 19I platform bundle](https://github.com/proompteng/lab/blob/3de33a1a16a57b54c7f278e5b1eb8ffdcbbf6695/docs/cluster/ontology/cluster-knowledge.json)
owns the `SealedSecret` resource and `Tailscale` glossary entries. This bundle defines the distinct
`kubeseal` client and uses `SealedSecret` and `Tailscale` as rule search terms without registering
either name again.

## Validate locally

From the repository root with the script dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/security/ontology/security-rbac-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
bun test packages/scripts/src/agents/
```

Dry-run needs no credentials and performs no HTTP requests or writes. A future authorized publish
requires a reviewed revision, an explicitly onboarded `security` database, and the preconfigured
`security canonical rule` tag. Do not use another domain's database or tag as a substitute. Follow
the [Auto Ontology operations guide](../../agents/auto-ontology-operations.md) before any live apply.
