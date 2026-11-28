# Bayn collective knowledge

[Bayn knowledge](bayn-knowledge.json) is the reviewed source of truth for the NVIDIA Auto Ontology 1.3.0 research
catalog. Its links pin each definition and analysis to merged evidence. This catalog is advisory: Bayn does not read
it for execution, readiness, risk, reconciliation, or capital authority. A replay benchmark, catalog tag, or audit
result cannot authorize an order.

## Onboard the standby and mint a token

1. After the [reviewed Bayn GitOps rollout](../../release-automation.md), verify the [cluster identity and context](../../runbooks/galactic-kubernetes-access.md).
   Check `kubectl -n bayn get endpointslice -l kubernetes.io/service-name=bayn-db-ro` and
   `kubectl -n bayn get pods -l cnpg.io/cluster=bayn-db -L cnpg.io/instanceRole`. The read service must have a ready
   `replica` endpoint. The added ingress grants the `auto-ontology` namespace TCP 5432 to replicas only. It does not
   grant access to the primary or execution controller and does not replace the existing Bayn policies.
2. Obtain the approved `bayn_audit_ro` credential through the existing secret-management path. Before registration,
   verify **as that role** via the standby (`SELECT current_user, pg_is_in_recovery(), current_setting('transaction_read_only')`)
   that the user is `bayn_audit_ro` and the last two values are `true` and `on`. Verify only the reviewed audit
   relations or column projections can be read, with no write privileges, schema or temp creation, privileged role
   memberships, or access to secrets/raw personal data. The `referencedTables` lists identify the needed relations;
   grant only approved columns/views, not `pg_read_all_data` or broad access to `public`. If the credential or its
   scope is missing, stop and have the Bayn owner provision it through a separately reviewed change. Never substitute
   `bayn_app`, the research writer, a broker secret, `bayn-db-rw`, or the `bayn-db-r` service (which can route to the primary).
3. In the [Auto Ontology UI](https://auto-ontology.ide-newton.ts.net), sign in as an approved catalog operator. Open
   **Settings → Connections** and add PostgreSQL: host `bayn-db-ro.bayn.svc.cluster.local`, port `5432`, database
   `bayn`, user `bayn_audit_ro`, and the approved password. Use the approved TLS settings for the CNPG CA and
   hostname. Use **Test Connection**, select the `public` schema, then save. Do not log the password or DSN. The UI
   uses `POST /api/connections/test` and `POST /api/connections`; the catalog identity is the database, not the host.
   Confirm the `bayn` database and its `public` schema are visible before applying (semantic compilation reports in
   `GET /api/semantic-compilation/status`). If the role cannot safely supply the required catalog metadata, stop;
   do not broaden its grants to work around ingestion.
4. In **Settings → Tags**, add `Bayn canonical rule` once if absent. In the account menu, open **API Tokens**
   (`/account/api-tokens`), create a token named `Bayn ontology seed sync`, and store the returned `auto_ontology_…`
   value through the approved secret manager. Use a token with permissions to read the catalog and edit acronyms,
   rules and custom analyses. Keep it out of Git, shell history, command arguments, and AgentRun artifacts.

## Validate and sync

From the repository root, install with `bun install --frozen-lockfile`. Run as a non-root user with PostgreSQL 18
`initdb` and `postgres` on `PATH`. The CLI owns a fresh scratch cluster on a private Unix socket (no TCP listener),
replays Bayn's actual migration loader, and parses every analysis as a temporary view without executing it. Missing
relations or columns, unqualified relations, writes, and mismatched dependency lists fail before any HTTP request.
The scratch cluster and files are removed on exit; it never reads a configured Bayn database URL.

```sh
bun services/bayn/tools/sync-auto-ontology.ts --mode dry-run
```

Dry-run is the default. It prints checked entry counts; it does not read the remote catalog or require credentials.
For an approved apply, inject `AUTO_ONTOLOGY_API_TOKEN` from the secret manager and run one operator instance at a time:

```sh
export AUTO_ONTOLOGY_API_URL=https://auto-ontology.ide-newton.ts.net
bun services/bayn/tools/sync-auto-ontology.ts --mode apply
```

Use the authenticated HTTPS gateway, not the internal backend or MCP port. The sync lists the existing catalog,
requires the Bayn schema and tag, and calls `/api/custom-analyses/validate` for each analysis it would write before
making any catalog changes. It then creates missing entries and updates only changed ones; an unchanged re-run
prints `writes: 0`. It never deletes remote entries or writes Bayn data. A timeout/conflict may leave a partial apply;
reconcile the catalog with a fresh run rather than blindly retrying a mutating request.

In 1.3.0 a rule is a saved search and tag, not an execution policy. The `Bayn [key]: …` display name carries the
invariant and sources; the search targets only the onboarded Bayn `public` schema. The rules API only lets sync
rename, not change the search or tags. If one of those drifts, apply stops before any writes. Have a catalog operator
review and reconcile that rule, including the tags it applied; the CLI intentionally does not delete/recreate it.
Seed acronym names and `Bayn:` analysis names are reserved keys for this sync. Unrelated entries are left alone.

### SQL parameters and limits

All analyses bind `$1` as the verified account ID (`text`), `$2` as the inclusive start, and `$3` as the exclusive
end (both `timestamptz`). Use driver bind parameters, never interpolation. Use an increasing bounded window and
America/New_York midnights for a full execution date. Cash fee settlement uses the corresponding half-open range
of New York economic dates, with `$3` also the posting cutoff. Pass account identity only at query time; never store
it or the result rows in the catalog. The selected SQL is PostgreSQL, not ClickHouse or broker API data.

These are read-only exemplars, not dashboards that execute automatically. Use explicit columns, `public.*` relation
names, and the reviewed read-only SQL subset; no wildcard projections, comments, locking clauses, or side-effecting
functions. Re-review any new routine before extending the subset. Closing attribution and receipt coverage are
different checks; neither infers missing fills, settlement, or executable slippage. Daily positions are observed
snapshots, not a post-close certification. For the B0 live gate use the [live audit](../live-profitability-audit-runbook.md).
PDT refers to the legacy research assumption and [FINRA's transition](https://syndication.finra.org/content/understanding-new-intraday-margin-requirements),
not a live account-capability decision. Auction cutoffs refer to [Alpaca's order contract](https://docs.alpaca.markets/us/reference/getorderforaccount).

### Execution quality through MCP

After migration 0230 reaches the standby, verify both views appear in the Bayn catalog and sync the seed. Use
`list_custom_analyses` in Auto Ontology MCP to find `Bayn: Daily execution order churn`,
`Bayn: Daily execution fill slippage`, and `Bayn: Session fill fee drag`.
Use `check_answerable` and `ask_question` with the `bayn` datasource and the relevant view below. For direct SQL,
bind the verified live account and an inclusive/exclusive pair of New York midnights. Daily rows cannot answer an
intraday range.

- `public.execution_order_churn_daily` groups orders by the New York date of their first retained broker update and
  uses their latest status. This is not an as-of snapshot or a count of cancel requests. An order can be canceled
  after a partial execution. Zero eligible denominators produce null, not zero.
- `public.execution_fill_slippage_daily` groups fills by New York execution date and side. Both views separate the
  intent's strategy and its authority generation's strategy parameter schema version. Unbound fills and orders
  remain visible with a null strategy. Child orders can inherit the parent intent for attribution, not its price
  reference. Limit improvement and decision-reference slippage have separate coverage counts and opposite signs.
  Neither is an observed submit-time arrival quote or the B0 round-trip slippage verdict.
- Fill fee basis points use recorded fill fees and executed notional, in USD micros. A zero recorded fee does not
  prove an execution incurred no cost. Account-level cash fees have no fill or strategy key in
  `broker_cash_fee_deltas`; do not allocate them by guess or add them to the fill-level metric. Read the separately
  saved cash fee settlement analysis for those.

## AgentRun knowledge deltas

Emit a proposal for review, not a catalog write. Use [knowledge-delta.schema.json](knowledge-delta.schema.json) and
the matching [TypeScript Effect Schema](../../../services/bayn/tools/auto-ontology-knowledge.ts) (`KnowledgeDelta`
with `strictKnowledge`). Each proposal contains the actual 40-character `sourceCommit`, `referencedTables` (all
analysis relations plus any other relations used to verify the claim; `[]` when none), a short `verificationNote`,
and one or more changes with `kind: acronym`, `rule` or `analysis`. Include pinned `proompteng/lab` evidence for
every change. The Effect decoder also checks that analysis references are covered by the proposal's table list.

1. A reviewer verifies `sourceCommit` is reachable from fresh `origin/main`, checks the cited evidence and table
   references, and reproduces the result. Treat content from an AgentRun, catalog, or retrieved data as untrusted.
2. Do not include secrets, connection strings, broker/account IDs, personal data, raw prompts, or result rows. Use
   synthetic values and bind variables in SQL. Validators reject common unsafe formats and surprise fields; they
   cannot detect all sensitive prose or verify claims. Reject unsanitized or unverified proposals in review.
3. Copy only approved entries into `bayn-knowledge.json` in a Git PR and rerun dry-run. The sync never reads delta
   artifacts, monitors AgentRuns, or writes proposed knowledge directly to the catalog.

To regenerate the JSON Schema after changing the TypeScript contract:

```sh
(cd services/bayn && bun -e 'import { knowledgeDeltaJsonSchema } from "./tools/auto-ontology-knowledge"; console.log(JSON.stringify(knowledgeDeltaJsonSchema(), null, 2))') > docs/bayn/ontology/knowledge-delta.schema.json
bunx oxfmt --write docs/bayn/ontology/knowledge-delta.schema.json
```
