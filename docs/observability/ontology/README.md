# Observability Auto Ontology knowledge

[Observability knowledge](observability-knowledge.json) is the reviewed version 1 bundle for Galactic's telemetry
stack. The [Observability GitOps application](../../../argocd/applications/observability/README.md) owns deployment and
runtime settings. The bundle's rules are operator guidance, not controls that enforce collection, alerting, or
retention. Each rule records the source commit and evidence used in review.

Acronym names are global and compared without regard to case. Check the [Agents](../../agents/ontology/agents-knowledge.json)
and [Bayn](../../bayn/ontology/bayn-knowledge.json) bundles before adding names. `Talos`, `Omni`, `ArgoCD`, `LGTM`,
`Mimir`, `Loki`, and `Tempo` belong to Wave 19I and are not defined here.

## Validate locally

From the repository root with Bun dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/observability/ontology/observability-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Dry-run validates the bundle without credentials, network calls, or writes. `customAnalyses` stays empty: the
native metric, log, and trace query languages are not PostgreSQL SQL. `observability` is the bundle's source key,
not a connection provisioned by this change. The [shared sync](../../agents/ontology/README.md#other-domains) requires
a matching onboarded database and the `observability canonical rule` tag for apply. Do not point it at an unrelated
database. Catalog apply and GitOps changes are outside this wave.
