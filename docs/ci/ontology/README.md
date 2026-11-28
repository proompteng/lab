# CI and release Auto Ontology knowledge

[CI release knowledge](ci-release-knowledge.json) is the version-1 glossary and advisory rule bundle for Galactic's CI,
ARC self-hosted runners, and Kargo image delivery. [Release automation](../../release-automation.md) and
[AGENTS.md](../../../AGENTS.md) remain authoritative. Catalog rules are saved searches with tags, not CI gates or
promotion policies.

## Glossary ownership

Acronym names are case-insensitive global catalog identities. Use the canonical `ARC` (Actions Runner
Controller), `Kargo` (image promotion), and `Freight` (the immutable artifact record) entries from the
[Agents bundle](../../agents/ontology/agents-knowledge.json); this bundle does not register them again. Compare new
names against Agents, [Bayn](../../bayn/ontology/bayn-knowledge.json), the Galactic platform (Wave 19I), and
observability (Wave 19Q) before adding them.

## Offline validation

From the repository root with Bun and workspace dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/ci/ontology/ci-release-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Dry-run validates the bundle without credentials, network calls, or catalog writes. Review names across bundles and
check descriptions for sensitive data; offline validation does not inspect the live catalog or prove a release.

`customAnalyses` is empty. The `ci-release` key identifies this bundle; it does not onboard a database or provision
credentials or catalog tags. An apply would require separately approved onboarding of a matching database and the
`ci-release canonical rule` tag. Do not substitute another domain's data source.
