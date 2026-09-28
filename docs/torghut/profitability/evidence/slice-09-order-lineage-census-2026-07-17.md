# Slice 9 Production Evidence: Immutable Order Lineage Census

Status: production-proven for the historical closed-census and exact-input idempotence invariants. Changed-source
append behavior and a fresh complete paper causal chain remain unproved, so Slice 9 is not complete.

Evidence window: `2026-07-17T05:50Z` through `2026-07-17T06:12:31Z`.

## Invariants And Scope

The production exercise tested that:

- every retained historical order-feed or broker-activity identity receives one current immutable receipt;
- the builder never updates or deletes order events, broker activities, executions, decisions, claims, or TCA rows;
- repeating the exact closed input reuses the import, receipts, and run instead of creating duplicates;
- repaired or incomplete historical evidence remains diagnostic and permanently promotion-ineligible.

The exercise did not manufacture missing causal links. It does not prove a fresh strategy lifecycle, correct economic
P&L, strategy profitability, TigerBeetle parity, or permission to increase capital.

## Immutable Delivery Chain

| Boundary          | Evidence                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source PR         | `#12720`, `fix(torghut): accept monotonic closed-scan watermarks`                                                                                    |
| Source merge      | `1692da9586eb90cd91b6574ab6a442ab72a7f7e8`                                                                                                           |
| Focused tests     | `10 passed`; later identical scan accepted and regressed watermark rejected                                                                          |
| Related tests     | `56 passed, 2 skipped`; skips require an explicit PostgreSQL DSN                                                                                     |
| Static validation | Ruff, Pyright, Python compilation, Oxfmt, and diff checks passed                                                                                     |
| PR CI             | Eight pytest shards, four autoresearch shards, PostgreSQL CAS, Pyright, coverage, lint, migration, and planner checks passed                         |
| Image build       | Multi-architecture workflow `29557877620` succeeded                                                                                                  |
| Image identity    | `registry.ide-newton.ts.net/lab/torghut@sha256:96472863a474a0b68a11c5a48584ca5da05d3561c29c33eceb79c88aa83e753d`                                     |
| Release workflow  | Workflow `29558026570` succeeded                                                                                                                     |
| Promotion PR      | `#12721`, merged as `7a4c34b0dd2ff0a00d84250cd2b4af818b3cb98c`                                                                                       |
| Core GitOps state | Argo application `torghut`: exact promotion revision, `Synced`, `Healthy`, operation `Succeeded`; migration 0082 completed before workload readiness |

The promoted scheduler reported one ready and one available replica on the exact image and source. Knative services
`torghut` and `torghut-sim` were Ready at revisions `torghut-01504` and `torghut-sim-01576`.

## Closed Census Result

The production builder ran with `closed_census=true`, `apply=true`, and promotion disabled. Its input contained 40,165
broker activities and 15,428 order events. It persisted one immutable run and 16,619 current receipts:

| Classification         |      Count |
| ---------------------- | ---------: |
| `ambiguous`            |          1 |
| `broker_activity_only` |      2,408 |
| `complete`             |          0 |
| `external_or_unproved` |        142 |
| `linked_incomplete`    |     13,737 |
| `order_feed_only`      |        331 |
| **Total**              | **16,619** |

Source coverage was 13,880 identities on each side, 2,408 broker-only identities, and 331 feed-only identities. The
first run inserted 16,619 receipts and reported `source_rows_mutated=0`.

Direct CNPG readback independently found:

- 16,619 receipts with 16,619 distinct evidence-state identities;
- one immutable canonical import and one immutable repair run;
- zero promotion-eligible receipts and zero promotion-eligible runs;
- confidence counts of 14,897 exact, 1,721 unproved, and 1 ambiguous;
- execution sources of 14,661 local, 236 canonical, and 1,722 unresolved.

Every persisted run count summed exactly to the receipt count. `/trading/status` exposed the supported run as
`closed_census=true`, current repair version, 16,619 receipts, zero causal-complete receipts, and 16,619 incomplete
receipts with reason `order_lineage_incomplete_or_unproved`.

## Idempotence And Non-Mutation Proof

An immediate production rerun over the identical closed input completed successfully with:

```json
{
  "inserted_receipt_count": 0,
  "receipt_count": 16619,
  "reused_receipt_count": 16619,
  "run_reused": true,
  "source_rows_mutated": 0
}
```

The classification, confidence, execution-source, and source-coverage totals were identical to the first run.

The first natural hourly execution after the corrected image was promoted also succeeded. Kubernetes Job
`torghut-order-lineage-reconciliation-29737812` started from the CronJob at `2026-07-17T06:12:00Z` and completed at
`2026-07-17T06:12:31Z` with zero retries. It read the same 40,165 broker activities and 15,428 order events, reused all
16,619 receipts and the sealed run, inserted nothing, reported zero source-row mutations, and kept promotion authority
false. This proves the GitOps schedule and deployed default path, not only manually copied Jobs.

Before the first census, fixed UTC cutoffs were recorded independently for the primary and simulation databases. Row
count plus PostgreSQL MVCC identity fingerprints were computed for broker activities, broker-economic inputs, order
events, TCA rows, executions, submission claims, and decisions. Every fixed-cutoff count and fingerprint remained
identical after both production runs. This verifies non-mutation at the database source boundary rather than trusting
the script's result field alone.

## Defect Found And Corrected

One production validation run rejected a valid input after a no-change source scan advanced only the cursor watermark.
The original equality check contradicted the database contract, which permits a later completed scan when cursor
identity, activity count, manifest hash, and canonical input remain exact. Source PR `#12720` changed the check to
accept only a monotonic later watermark; a regressed watermark or any changed source set still fails closed. Regression
tests cover both directions.

## Remaining Gates

- Prove that a genuinely changed source state appends a new immutable receipt state without changing the prior one.
- Produce a fresh, fenced scheduler paper lifecycle linking strategy, decision, submission claim, execution, TCA,
  order-feed event, and broker fill. Historical data cannot substitute for this proof.
- Re-run the independent economic ledger after settled broker fees arrive and require zero unexplained settled delta.
- Complete the later TigerBeetle parity and profitability gates before any capital increase.

The evidence window had no active broker capital grant and occurred outside the regular market session. No synthetic
or infrastructure-validation order was treated as strategy evidence. Real-capital risk-increasing submission remains
blocked.

## Verdict

The historical Slice 9 census is deployed, immutable, repeatable, and independently verified not to mutate source
rows. Its truthful result is also negative: the historical corpus contains zero complete causal chains. Slice 9 remains
open until the changed-source append and fresh bounded paper lifecycle gates pass.
