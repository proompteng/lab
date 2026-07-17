# Order And Fill Lineage Repair Receipts

Status: normative Slice 9 implementation contract; Delivery 1 schema and deterministic evidence builder implemented.

## Decision

Torghut will repair historical order lineage with one append-only receipt per broker order evidence state. A receipt
groups every known order-feed event and broker account activity under the broker's stable order identity, then records
the uniquely resolved execution, decision, strategy, submission claim, and TCA identities when they exist.

The receipt is evidence, not authority. It is always marked `promotion_authority_eligible=false`. A repaired historical
row can explain a result or exclude it from promotion; it can never turn an unfenced legacy order into a valid current
submission.

This is intentionally one table and one deterministic builder. The immutable JSON document is the causal evidence
authority; the table projects only scope, classification, identity, and source-window fields needed for current-state
selection. Slice 9 does not add a lineage graph service, queue, mutable repair cursor, approval workflow, confidence
score formula, duplicate writable link columns, or generic provenance framework.

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

At least one order ID is required. The broker order ID is primary when present; the client order ID is the explicit
fallback. Adding a client ID to evidence that already has a broker order ID therefore appends evidence under the same
identity instead of manufacturing a second order. The canonical primary identity is SHA-256 hashed. A receipt is
uniquely keyed by identity, repair version, and evidence digest. Repeating the same evidence reuses the same row. Later
order events or broker activities produce a new append-only evidence state; older states remain inspectable.

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
- indexes for current-version selection and classification census;
- a PostgreSQL trigger that verifies the immutable JSON document and SHA-256, primary identity, source arrays and
  subsets, timestamps, causal-link shape, explicit blockers, and complete-link requirements on insert;
- update, delete, and truncate rejection.

The trigger stamps `created_at`; callers supply `observed_at`. No repaired receipt has a foreign key to a row in a
different database, because that would be a false database guarantee. Cross-DSN IDs instead remain scope-bound inside
the hashed evidence contract.

## Delivery Sequence

1. Land the table, database guards, deterministic builder, and contract tests.
2. Replace `reconcile_cross_dsn_order_feed_links.py` raw-JSON mutation with order-level receipt construction, a closed
   run manifest, and repeatable atomic backfill. Retain original event rows unchanged.
3. Add current-version coverage metrics and explicit residual classifications to trading status.
4. Run the historical census, then prove a fresh bounded paper lifecycle with complete claim/order/fill/event linkage.

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
