# Galactic cluster and release knowledge

[Galactic knowledge](cluster-knowledge.json) is the version-1 Auto Ontology glossary and operational rule bundle for
Galactic infrastructure and GitOps releases. The rules are advisory saved searches, not enforcement policies or
authorization to operate the cluster. The bundle has no SQL analyses: it does not onboard or query a Galactic database.

## Sources for review

- Cluster ownership and access: [Galactic cluster](../../../devices/galactic/README.md) and the
  [Kubernetes access runbook](../../runbooks/galactic-kubernetes-access.md).
- Application reconciliation and namespaces: [ApplicationSets](../../../argocd/applicationsets/README.md) and the
  infrastructure contracts in [AGENTS.md](../../../AGENTS.md).
- Platform terms: [observability](../../../argocd/applications/observability/kustomization.yaml),
  [Rook-Ceph](../../runbooks/rook-ceph-on-talos.md), [Restate](../../../argocd/applications/restate/README.md), and
  [Temporal](../../../argocd/applications/temporal/README.md).
- Image eligibility, promotion, and rollout proof: [release automation](../../release-automation.md).

Update this bundle through Git review against those sources. Acronym identities are global; keep each Galactic name
distinct, ignoring case, from the [Agents](../../agents/ontology/agents-knowledge.json),
[Bayn](../../bayn/ontology/bayn-knowledge.json), and [CI release](../../ci/ontology/ci-release-knowledge.json) seeds.
Refer to terms already owned by those bundles, such as `Kargo`, `Freight`, `Attic`, `Stage`, and `Warehouse`, rather
than redefining them here.

## Validate offline

From the repository root with Bun dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/cluster/ontology/cluster-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Dry-run validates the bundle without credentials, network requests, or catalog writes. `galactic` is the bundle's
source key, not a provisioned connection. Applying the bundle would require separate approval, an onboarded database
named `galactic` (the default for this source key), and the `galactic canonical rule` tag. Do not point the bundle at
another domain's database to make apply pass. Keep `customAnalyses` empty until a reviewed, read-only Galactic data
source and schema exist.
