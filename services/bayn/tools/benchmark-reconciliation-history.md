# Reconciliation history query measurements

`readAccountingHistory` in `src/db/reconciliation.ts` materializes posted inventory debits once, then computes
each transaction's prior inventory and cost basis using the inclusive `effective_at <= occurred_at` boundary.
Grouping that materialization by account, symbol, and the exact PostgreSQL effective timestamp reduces repeated
scans of coincident fee debits. Quantity and cost basis remain exact PostgreSQL numeric sums. Distinct effective
timestamps, including sub-millisecond differences, remain separate. The query still returns every accounting row;
decoding and full accounting verification run on every read.

On November 16, 2026, the baseline at `13f85e995fb53f62f198b8b51ca6e6ea4db2a283` and this change were compared
on the existing PostgreSQL read replica for the current authority's account. No source rows were changed.
Both queries ran in one `REPEATABLE READ READ ONLY` transaction with a ten-second statement timeout.
`EXCEPT ALL` in both directions compared every output field: both queries returned 1,863 rows, with zero differences.
The inventory materialization shrank from 230 rows to 86; the correlated aggregate still ran 1,652 times.

For timing, nine rounds alternated baseline then candidate using `EXPLAIN ANALYZE` with per-node timing disabled
and JSON output in one read-only repeatable-read snapshot. The first two
rounds were discarded as warmup. The remaining PostgreSQL execution times were:

| Round | Baseline (ms) | Grouped (ms) |
| ----: | ------------: | -----------: |
|     1 |        47.208 |       34.793 |
|     2 |        47.053 |       34.455 |
|     3 |        47.382 |       35.499 |
|     4 |        49.400 |       35.895 |
|     5 |        49.098 |       36.444 |
|     6 |        50.748 |       36.171 |
|     7 |        50.311 |       38.094 |

Median SQL execution time fell from 49.098 ms to 35.895 ms, a 26.9% reduction in this account snapshot.
These measurements exclude network transfer, row decoding, accounting verification, TigerBeetle reads, and the
rest of reconciliation. Shared-host activity and fixed query order can affect timings. They do not establish
deployed quote-to-broker latency, reduced charged costs, or improved trading profit.

The PostgreSQL integration regression exercises two coincident posted coin fees, a fee one microsecond after
the sell, an unposted fee, another symbol, and another account. It checks exact sell cost basis and realized P&L,
then changes a posted fee and requires a fresh history read to fail verification. The full execution-store
integration file passed all 41 tests against isolated PostgreSQL 18.7 with Bun 1.4.2:

```sh
BAYN_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:55437/bayn_reconciliation_history_test \
  bun test services/bayn/src/db/execution-store.integration.test.ts --timeout 150000
```

To repeat the SQL comparison, select an explicitly scoped account and run the baseline and candidate query bodies
from the two revisions in one read-only repeatable-read snapshot. Compare both directions with `EXCEPT ALL` before
timing. Keep the account predicate, row ordering, exact numeric sums, and timestamp boundaries unchanged. This
measurement does not justify caching history, skipping verification, or weakening execution deadlines.
