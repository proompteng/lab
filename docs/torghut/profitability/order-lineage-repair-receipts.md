# Order And Fill Lineage Repair Receipts

Status: normative Slice 9 implementation contract; the immutable historical production census and deterministic rerun
are proven; changed-source append and fresh-paper causal-chain proof remain pending.

## Decision

Torghut will repair historical order lineage with one append-only receipt per broker order evidence state. A receipt
groups every known order-feed event and broker account activity under the broker's stable order identity, then records
the uniquely resolved execution, decision, strategy, submission claim, and TCA identities when they exist.

The receipt is evidence, not authority. It is always marked `promotion_authority_eligible=false`. A repaired historical
row can explain a result or exclude it from promotion; it can never turn an unfenced legacy order into a valid current
submission.

Receipt evidence intentionally stays in one table with one deterministic builder. Delivery 2 adds only the closed-run
table and a compact, immutable cross-DSN import table needed to prove the run's input boundary. The immutable JSON
document is the causal evidence authority; the receipt table projects only scope, classification, identity, and
source-window fields needed for current-state selection. Slice 9 does not add a lineage graph service, queue, mutable
repair cursor, approval workflow, confidence score formula, duplicate writable link columns, or generic provenance
framework.

## Evidence That Requires Repair

The production census at `2026-07-16T23:40Z` found:

- `15,428` normalized order-feed events and `14,211` distinct order identities;
- `13,972` events with an effective execution link and `13,973` with an effective decision link;
- `1,456` events without an execution link, including `536` fill events across `372` orders;
- the existing cross-DSN matcher can uniquely resolve `769` of `1,475` selected legacy rows to `193` canonical
  executions and decisions, with zero ambiguous execution matches;
- `706` selected rows remain unmatched and therefore require explicit classification;
- `40,099` REST broker fill activities cover `16,288` broker orders; `2,424` of those orders have no fill event in the
  retained order feed;
- all `14,995` retained live execution rows predate current submission-claim proof and therefore cannot be upgraded
  into claim-backed evidence by inference.

The current repair script writes cross-database identifiers into mutable `raw_event` and source-window JSON. That
surface is useful for navigation but is not an append-only proof, does not retain unmatched classifications, and cannot
represent multiple broker fills for one order without repeated embedded payloads.

## Receipt Grain And Identity

The grain is one observed evidence state under a stable primary order identity:

```text
(provider, environment, account label, primary order-ID kind, primary order-ID value)
```

At least one order ID is required. A new identity uses the broker order ID when present and otherwise uses the client
order ID as its fallback. Once established, that primary identity never changes: when a later observation adds the
missing broker or client alias, the writer resolves the existing scoped alias under a transaction lock, carries both
IDs forward, and appends under the original identity. Conflicting independent histories fail closed instead of being
silently merged. No second alias table or mutable mapping authority is introduced. The canonical primary identity is
SHA-256 hashed from a byte-length-prefixed scope and primary-ID tuple so PostgreSQL can independently derive it. A
receipt is uniquely keyed by identity, repair version, and evidence digest. Repeating the same evidence reuses the same
row. Later order events or broker activities produce a new append-only evidence state; older states remain inspectable.

Consumers select only the explicitly supported `repair_version` and the latest evidence state per order identity.
Removing a version from the supported set invalidates it for current proof without deleting or rewriting its rows.

Per-order receipts alone do not prove that a whole census finished. Delivery 2 must publish one closed run manifest in
the same transaction as any new receipt states, under one scope-level database lock. That manifest must bind the broker
input ID, order-feed watermarks, canonical-execution watermark, expected identity count, classification counts, and a
digest of the complete current receipt set. Until that exists, Delivery 1 rows are inspectable evidence only and must
not be reported as current coverage.

## Evidence Contract

Each receipt stores and hashes one canonical JSON document containing:

- exact scope and order identity;
- sorted order-feed event IDs and the subset that carry positive fill deltas;
- sorted broker activity IDs and the subset that are economic fills;
- first and last causal source timestamps;
- exact match basis: broker order ID, client order ID, or both;
- execution source: local database, canonical cross-DSN database, or none;
- execution, decision, strategy, submission-claim, and TCA IDs when proven;
- one coarse classification, confidence, and explicit blocker list;
- a permanent `promotion_authority_eligible=false` marker.

Links and source counts exist once inside this document. They are not copied into independently writable relational
columns. At the current order volume, direct JSONB inspection is cheaper and safer than maintaining a second authority.

One-to-many partial fills are preserved as multiple broker activity IDs under one order identity. The system does not
pretend that a cumulative trade-update event maps one-to-one to an individual venue fill when Alpaca did not provide
that identity in the stream event.

## Classifications

| Classification         | Meaning                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `complete`             | Exact execution, decision, strategy, claim, TCA, order-feed, and broker-fill evidence all exist |
| `linked_incomplete`    | An exact execution exists, but named causal links or economic source evidence are missing       |
| `external_or_unproved` | No canonical execution can be proven; manual/external origin remains possible, not asserted     |
| `ambiguous`            | More than one canonical execution matches; no winner is selected                                |
| `broker_activity_only` | REST economic activity exists without retained order-feed evidence                              |
| `order_feed_only`      | Order-feed evidence exists without retained broker economic activity                            |

`broker_activity_only` and `order_feed_only` describe source coverage, so they retain an exact execution link when one is
proven. They use `unproved` only when no execution is proven. A missing source never authorizes deleting a causal link.

Confidence is limited to `exact`, `unproved`, or `ambiguous`. There is no floating-point confidence score. Exact means
a unique stable identity match, not a timestamp heuristic. Unproved rows remain excluded from promotion.

## Database Enforcement

Migration `0081_order_lineage_receipts` creates `order_lineage_repair_receipts` with:

- check constraints for identity, classifications, execution-source consistency, and source windows;
- unique evidence-state identity for repeatable backfill;
- indexes for current-version selection, classification census, and scoped broker/client alias resolution;
- a PostgreSQL trigger that verifies the immutable JSON document and SHA-256, primary identity, source arrays and
  subsets, timestamps, causal-link shape, explicit blockers, and complete-link requirements on insert;
- exact PostgreSQL JSONB canonical bytes, with the identity digest independently recomputed instead of trusted from the
  caller;
- update, delete, and truncate rejection.

The trigger stamps `created_at`; callers supply `observed_at`. No repaired receipt has a foreign key to a row in a
different database, because that would be a false database guarantee. Cross-DSN IDs instead remain scope-bound inside
the hashed evidence contract.

Migration `0082_order_lineage_runs` adds the closed-census boundary. One append-only run binds:

- the exact Slice 8 broker-economic input row, source, manifest hash, source watermark, and activity count;
- complete order-feed, broker-order-link, local-execution, and canonical-execution manifests;
- the expected order-identity count and digest of every current receipt identity/evidence pair;
- classification, confidence, execution-source, and source-coverage counts that each sum to the receipt count.

The database does not trust caller-supplied local coverage hashes. Its insert guard derives the broker-order-link
manifest from `broker_account_activities`, the order-feed manifest and partition bounds from
`execution_order_events`, and the local-execution manifest from executions, decisions, submission claims, and TCA
rows. It derives the complete current receipt set and every result count from persisted receipts, then compares the
entire input and result documents rather than checking selected fields.

PostgreSQL cannot re-query a different database inside this transaction. The canonical cross-DSN projection is
therefore bound through an immutable, content-addressed import containing the source-database identity hash, canonical
account-label hash, execution count, execution-set digest, and watermark. The run has a restrictive foreign key to
that exact import. The import's canonical document and content hash are independently checked on insert; update,
delete, and truncate are rejected. Identical canonical projections reuse the import instead of copying the execution
set every hour. This is the explicit cross-database trust boundary, not a false foreign-key claim.

PostgreSQL also verifies the referenced broker input and every count and takes one transaction-scoped advisory lock
per repair scope. Both run documents must use exact PostgreSQL JSONB canonical bytes, so alternate whitespace or key
ordering cannot manufacture a second input hash. Timestamp text follows PostgreSQL's UTC JSONB rendering, including
trimmed fractional-second zeros, and the guards execute with a function-local UTC setting. The import, receipt states,
and run are committed in the same transaction. A later completed source scan may advance the cursor watermark only
when the cursor identity, activity count, manifest hash, and canonical input remain exact; a regressed watermark or
changed source set fails closed. Repeating identical inputs reuses the run; the same input producing a different result
fails as nondeterministic.

## Runtime Census

`reconcile_cross_dsn_order_feed_links.py` now performs one full closed census and never mutates `raw_event`, source
windows, executions, decisions, or orders. It bulk-loads the source sets, indexes executions by broker and client
identity, preserves one-to-many fills, and rejects ambiguous stable-ID matches without timestamp heuristics. Client-only
events join a broker order only when the alias is unique.

The hourly `torghut-order-lineage-reconciliation` CronJob was enabled through a separate GitOps change only after the
closed-census image and migration 0082 were live at the exact promoted source and digest. This prevented the prior
image's legacy mutation path from running during the source-to-promotion gap. It runs after the broker-economic ledger
window with `concurrencyPolicy: Forbid`, no service-account token, no broker credentials, and no configured account
label. Source and canonical account scopes are inferred only when each is unique; ambiguity fails the job. The release
updater pins this CronJob to the same image digest and source commit as the API, scheduler, simulation service, and
economic-ledger job without changing its suspension state.

`/trading/status` exposes the latest supported closed-run counts under `order_lineage`. The payload is diagnostic only,
does not claim time freshness for a reused run, and always reports `promotion_authority_eligible=false`. Kubernetes job
success plus the immutable source manifests provide execution-freshness proof; an old reused run row alone does not.

The first production census and exact-input rerun are recorded in
[Slice 9 production evidence](evidence/slice-09-order-lineage-census-2026-07-17.md). The historical corpus contains no
complete causal chain and therefore cannot satisfy the fresh-paper acceptance gate or grant promotion authority.

## Delivery Sequence

1. **Implemented:** land the receipt table, database guards, deterministic builder, and contract tests.
2. **Implemented:** replace raw-JSON mutation with order-level receipt construction, a closed run manifest, and
   repeatable atomic backfill while retaining original rows unchanged.
3. **Implemented:** add current-version coverage and explicit residual classifications to trading status.
4. **In progress:** the closed-census image and migration are live, the CronJob is enabled through a separate GitOps
   change, and the historical census plus exact-input rerun are proven without source mutation. Prove a changed-source
   append and a fresh bounded paper lifecycle with complete claim/order/fill/event linkage.

Delivery 1 grants no runtime writer and cannot change an existing event, order, decision, or execution.

## Acceptance

Slice 9 is complete only when:

- every retained order-feed and broker-fill order is represented by native links or a current-version receipt;
- exact matches, ambiguous matches, external-or-unproved orders, feed-only orders, and activity-only orders are counted
  separately;
- rerunning the same census creates no duplicate receipt;
- a changed source state appends a new receipt without mutating the old one;
- fresh paper activity proves execution, decision, strategy, submission claim, TCA, order-feed, and broker-fill links;
- every incomplete or repaired legacy row remains promotion-ineligible.

This establishes causal coverage. It does not establish correct P&L, TigerBeetle parity, profitable strategy behavior,
or permission to increase capital.
