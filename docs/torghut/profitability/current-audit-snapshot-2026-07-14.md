# Torghut Profitability Audit Snapshot - 2026-07-14

Status: Time-stamped observed evidence. Not a capital authorization.

Repository source baseline: `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`.

Live audit window: `2026-07-14T05:48:00Z` through `2026-07-14T06:06:33Z`.

Normative design: [adversarial profitability system design](adversarial-profitability-system-design.md).

## Authority And Scope

This document records a bounded read-only audit of current source, Git history, Argo/Kubernetes state, direct runtime
status, CNPG/Postgres evidence, and primary external research. Counts and live states are historical immediately after
capture. A current decision must repeat the probes.

Evidence priority for this snapshot was:

1. broker economic facts when exposed by the audited system;
2. direct scheduler and websocket endpoints;
3. CNPG source rows and exact bounded SQL;
4. Argo and Kubernetes child-resource state;
5. source code, tests, GitOps, and Git history;
6. dated design documents as context only.

No cluster, database, broker, GitOps, or application mutation was performed. Account labels, credentials, tokens, and
raw private broker payloads are intentionally omitted.

## Audit Conclusion

Torghut was contained but not profitability-ready:

- the latest position snapshot was flat;
- Argo was Synced/Healthy and the singleton scheduler was running;
- the scheduler remained `503 degraded` and denied live submission;
- there was no current live runtime ledger;
- recent executions were not canonically linked to order-feed events;
- broker-mutation fencing code was present but explicitly unwired from production mutation paths;
- TigerBeetle reconciliation was stale and bounded rather than exhaustive;
- the only blocker-free candidate evidence was paper-stage, stale, and too small for inference;
- Hyperliquid remained disabled/testnet-only and failed timestamp, fill-linkage, sample, and after-fee checks.

The current evidence therefore supports continued blocking of risk-increasing submission. It does not establish that
any strategy is profitable, that the `$500/day` objective is feasible, or that the production economic ledger is exact.

## Source And Git History Audit

The worktree was clean and matched `origin/main` at the source baseline above.

Relevant current source findings:

- `argocd/applications/torghut/scheduler-deployment.yaml` defines one scheduler replica and a Postgres advisory
  leadership contract, so the process-level singleton containment is real.
- `services/torghut/tests/test_broker_mutation_receipts_unwired.py` asserts that the receipt package is absent from all
  listed Alpaca, execution, closeout, governance, and Hyperliquid mutation paths.
- `services/torghut/app/strategies/catalog.py::StrategyConfig` has `enabled` and sizing fields but no typed strategy
  capital stage.
- `services/torghut/app/trading/evidence_epochs.py::EvidenceEpochDecision` uses
  `shadow_only/research_allowed/paper_allowed/canary_allowed/live_allowed/scale_allowed/quarantined`, while proof-floor,
  submission-council, global flags, and strategy-name stages add adjacent authority surfaces. No audited contract
  consolidated them into one bounded strategy authority.
- `services/torghut/app/trading/runtime_strategy_resolution.py::family_template_id_from_strategy_id` removes text
  after the first `@`; GitOps uses `@paper` and `@research` in strategy IDs.
- `services/torghut/scripts/strategy_autoresearch_loop/run_strategy_autoresearch_loop.py` sets run-level
  `objective_met` for any objective-hitting top candidate before skipping candidates whose status is `discard`.
- `services/torghut/app/trading/discovery/promotion_contract.py` defines a strong final contract, including 20
  source-backed trading days, 300 closed trades, daily-distribution, drawdown, concentration, and target-implied
  notional requirements. It correctly separates bounded probation evidence collection from final authority.
- `services/torghut/config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml` evaluates near 1x
  gross, while live GitOps permits 4x gross. That is an execution-envelope mismatch, not promotion parity.
- current scheduler and API GitOps require the TigerBeetle protocol but set
  `TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=false`, so stale or mismatched economic reconciliation is not itself a
  readiness blocker.
- the runtime-ledger implementation rejects TCA as a profit shortcut and records blockers for missing fills, costs,
  closed round trips, policy hashes, and lineage. The ledger design is stronger than the available current evidence.

Relevant July merge history separated the safety components:

| Merge commit                 | Change                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `3f89079a5`                  | isolate singleton trading scheduler, PR `#12233`                                       |
| `94d81f2c0`                  | fence broker submission claims, PR `#12236`                                            |
| `f8e4da31e`                  | fence broker mutation receipts, PR `#12237`                                            |
| `5841bc594`                  | settle linked submissions atomically, PR `#12239`                                      |
| `1390a27e3`                  | add strict Alpaca order lookup, PR `#12282`                                            |
| `6b977cddd` then `bbae62039` | schedule, then remove, scheduled TigerBeetle reconciliation, PRs `#12107` and `#12227` |

The source audit found that landing those data structures and isolated controls did not establish production
reachability or a complete broker-economic proof chain.

## Final Live Readback

At `2026-07-14T06:06:33Z`:

| Surface                     | Observed state                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Argo application            | `Synced/Healthy`, revision `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`                    |
| Scheduler build             | commit `d8d24cd01df091dedde7e32c262fea96cc3d7d11`                                        |
| Scheduler image             | `sha256:9ac44017971f0c95d8ddabff556b113e23e121a22dc0e17d25a4ed39a59f9c9f`                |
| Scheduler process           | singleton, running, current leader                                                       |
| Scheduler `/readyz`         | HTTP `503`, `signal_continuity_alert_active`                                             |
| Operational submission gate | `allowed=false`                                                                          |
| Gate blockers               | `signal_continuity_alert_active`, `mainnet_route_unavailable`                            |
| Market route                | pre-market, closed because the regular session was closed                                |
| Last decision               | `2026-07-10T16:18:28Z`                                                                   |
| Live runtime ledger         | zero buckets, `runtime_ledger_missing`                                                   |
| TCA                         | last computed `2026-07-10T16:18:46Z`, expected-shortfall coverage `0`, lineage `blocked` |
| TigerBeetle                 | protocol reachable; reconciliation stale by `261269` seconds                             |
| Websocket forwarder         | final re-read `ready=true`; all four gates true                                          |

The websocket result requires context. Earlier in the same audit window, the pod had a prolonged provider `406
connection limit exceeded` incident and repeated reconnect/readiness changes. The final re-read proved recovery at that
instant, not market-open continuity. Only four of the ten configured symbols appeared in the latest accepted readiness
window, and scheduler signal continuity still reported `cursor_ahead_of_stream`.

Argo health, pod readiness, websocket recovery, scheduler readiness, and capital readiness were therefore distinct
truth surfaces.

## CNPG And Postgres State

CNPG reported one healthy primary, current Alembic head `0061_linked_submission_terminal`, healthy backup/archive
conditions, a `50 GiB` volume with approximately `21 GiB` used, and a database size near `19 GB`.

It was not a high-availability topology: there was one database instance and no replica. The audit also observed:

- API-to-scheduler and simulation readiness query timeouts;
- an `IdleInTransactionSessionTimeout` in scheduler outcome-labeling work;
- a long-running autovacuum on the options catalog waiting on WAL I/O;
- one transaction-ID lock waiter in a bounded activity snapshot;
- high dead-tuple estimates in options tables whose statistics were not accurate enough to quote as exact bloat.

Those are maintenance and availability signals. They do not prove data loss, but they show that schema-current and
CNPG Healthy are insufficient evidence for bounded runtime-query behavior or failover safety.

### Economic Evidence Inventory

| Dataset                            |    Rows | Latest timestamp       | Interpretation                                             |
| ---------------------------------- | ------: | ---------------------- | ---------------------------------------------------------- |
| `trade_decisions`                  | 154,339 | `2026-07-10T16:18:28Z` | no current-session decisions                               |
| `executions`                       |  14,995 | `2026-07-10T16:18:34Z` | no current-session executions                              |
| `execution_order_events`           |  15,364 | `2026-07-09T20:00:14Z` | stopped before latest executions                           |
| `execution_tca_metrics`            |  14,991 | `2026-07-10T16:18:46Z` | expected-shortfall prediction coverage zero in live status |
| `position_snapshots`               | 297,478 | `2026-07-14T05:52:52Z` | latest snapshot flat                                       |
| `order_feed_source_windows`        |  15,754 | `2026-07-09T20:02:34Z` | source windows stale                                       |
| `trade_decision_submission_claims` |       0 | none                   | no observed production proof session                       |
| `strategy_runtime_ledger_buckets`  |      60 | `2026-05-28T16:40:11Z` | all paper-stage; no live ledger                            |
| `tigerbeetle_reconciliation_runs`  |     647 | `2026-07-11T05:32:10Z` | stale versus one-hour threshold                            |

### Lifecycle Coverage

Cohort: decisions/executions created in the preceding 14 days.

| Evidence stage                                  | Numerator | Denominator | Coverage |
| ----------------------------------------------- | --------: | ----------: | -------: |
| Executed decision to fenced submission claim    |         0 |       1,172 |    0.00% |
| Executed decision to execution row              |     1,172 |       1,172 |  100.00% |
| Execution row to positive fill                  |       838 |       1,172 |   71.50% |
| Filled execution to TCA row                     |       838 |         838 |  100.00% |
| Filled execution to explicit-cost lineage       |       835 |         838 |   99.64% |
| Filled execution to fully source-backed lineage |       834 |         838 |   99.52% |
| Recent execution to order-feed event            |        18 |       1,172 |    1.54% |
| Recent filled execution to order-feed event     |        13 |         838 |    1.55% |

The entire claim cohort predates the current fenced-scheduler rollout. `0/1172` shows that this pre-rollout cohort has
no claim rows and supplies no post-rollout production observation; it cannot characterize behavior of the new writer.
Source reachability still blocks the feature because the repository explicitly asserts that mutation receipt APIs
remain unwired.

The TCA coverage numbers show row presence, not accurate economics. Three recent fills lacked explicit cost lineage,
four were not fully source-backed, expected-shortfall prediction coverage was zero, and the endpoint described its
bounded lineage sample as blocked.

## Accounting And Order-Lifecycle Contradictions

The strongest economic contradiction was July 10:

- Postgres recorded 819 filled buys and no sells;
- the latest position snapshot was flat.

Either the exits/flattening happened without canonical execution and order-feed records, or the stored filled rows were
not broker-authoritative. Both interpretations block reliable realized PnL and inventory attribution.

Additional observed inconsistencies:

- 825 of 838 recent filled executions had no linked order-feed event;
- 1,411 historical order events lacked `execution_id` and 1,410 lacked `trade_decision_id`;
- order-feed cursors had processed duplicates and one observed offset gap;
- three recent decisions remained `submitted` while their execution rows were `filled`;
- 16 canceled execution rows had positive filled quantity, so canceled status cannot be interpreted as zero fill and
  requires explicit partial-fill semantics;
- direct emergency closeout code did not create the same durable decision/execution/receipt lifecycle as ordinary
  strategy orders.

The system had no audited Alpaca Account Activities importer. Actual fees, corrections, busts, dividends, interest,
borrow costs, deposits, withdrawals, and broker cash/equity parity were therefore outside the canonical strategy PnL
authority.

## Runtime Ledger And Candidate Evidence

The runtime ledger contained 60 paper-stage buckets and no live-stage bucket. Three duplicate economic grains created
three extra rows. A later reconstructed pairs aggregate appeared to earn about `$16.5k`, but repeated identical buckets
inflated it and every contributing row carried non-promotion-grade reconstruction, cost, lineage, or open-position
blockers. It is not profit evidence.

Only six candidate variants had rows with no stored blockers:

| Candidate                   | Active days | Closed trades | Filled notional |    Net PnL | Net expectancy |
| --------------------------- | ----------: | ------------: | --------------: | ---------: | -------------: |
| `H-PAIRS-01 / c88421d6`     |           5 |             8 |   `$506,783.47` |  `$832.27` |    `16.42 bps` |
| `H-PAIRS-01 / 3e49d7da`     |           3 |             3 |   `$949,670.85` |  `$916.47` |     `9.65 bps` |
| `H-PAIRS-01 / 494798c7`     |           1 |             1 |    `$61,316.50` |   `$16.46` |     `2.68 bps` |
| `H-PAIRS-01 / 728383d3`     |           1 |             1 |   `$316,321.01` |  `-$52.84` |    `-1.67 bps` |
| `H-TSMOM-LIQ-01 / ca4e6e3c` |           4 |             7 |   `$330,677.66` | `-$177.82` |    `-5.38 bps` |
| `H-TSMOM-LIQ-01 / e3b166f2` |           1 |             1 |    `$29,982.15` |  `-$65.79` |   `-21.94 bps` |

All of those rows ended by May 21 and contained one to eight closed trades. They are descriptive directions, not
statistical or capacity evidence. The positive pairs rows warrant a properly controlled research hypothesis; the
negative TSMOM-liquidity rows do not justify promotion.

At the audit-time equity, `$500/day` would require approximately `1.21%` of NAV per active day. At `$300,000` daily
filled notional it would require `16.67` net basis points. The best tiny historical row was below that point estimate
and had no confidence, impact, or capacity margin. The target remains a hypothesis.

## TigerBeetle Evidence

The latest reconciliation finished `2026-07-11T05:32:10Z`, more than 72 hours before the final readback and beyond the
configured one-hour threshold.

Its reported `ok` state was bounded accounting-parity evidence:

- 42,896 transfer references existed;
- 526 transfers were checked by the latest run;
- the checked sample had zero missing or mismatched transfers;
- 26 runtime-ledger references were signed;
- 20,554 stable references existed;
- 22,342 stable-reference gaps were classified as diagnostic.

Typed source links existed for execution, TCA, order-event, and runtime-ledger projections. That is useful integrity
evidence, but protocol health and a bounded sample cannot override stale reconciliation, missing broker facts, or an
absent live profit ledger.

## Hyperliquid Snapshot

Hyperliquid was disabled and testnet-only. The independent lane showed:

- 1,473 testnet fills with aggregate after-fee net PnL of `-$431.328127`;
- 466 fills, `31.6%`, without `order_id`;
- one order marked filled without a fill row;
- 69,997 of 73,671 recent signals with `feature_event_ts > generated_at`;
- 68,725 signals more than 60 seconds in the future;
- a latest performance snapshot with zero recent fills/notional/PnL but `sample_ready=true`.

These defects block causal research, order/fill reconciliation, minimum-sample readiness, and profitability. The lane
must remain separate from equities and cannot supply capital evidence.

## Ranked Blockers At Snapshot Time

1. Enforce typed strategy-scoped capital authority before any risk-increasing broker I/O.
2. Wire submission claims and broker-mutation receipts into every mutation path and prove them under crashes.
3. Ingest immutable broker Activities and Trade Events and independently reconstruct positions, cash, equity, costs,
   and PnL.
4. Repair exit/closeout and order-feed attribution; resolve the July 10 buy-only/flat contradiction.
5. Produce current source-backed runtime-ledger buckets with exact costs and closed-round-trip lineage.
6. Restore fresh incremental and periodic exhaustive TigerBeetle reconciliation.
7. Fix autoresearch completion so a discarded candidate cannot declare the objective complete.
8. Unify research, promotion, paper, and live policy/execution envelopes.
9. Prove one websocket stream owner and full symbol/cursor continuity at market open.
10. Repair CNPG query/transaction/WAL behavior and add rehearsed HA.
11. Only then refresh the candidate board and run capacity-aware research.
12. Keep Hyperliquid disabled until timestamp, linkage, sample, and after-fee evidence passes independently.

## Reproduction Commands

Use an explicit namespace and read-only queries.

```sh
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main

kubectl -n argocd get application torghut \
  -o jsonpath='{.status.sync.status}{"|"}{.status.health.status}{"|"}{.status.sync.revision}{"\n"}'

kubectl -n torghut get pods -o wide
kubectl -n torghut get clusters.postgresql.cnpg.io -o wide

kubectl -n torghut exec <scheduler-pod> -- \
  python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8183/trading/status", timeout=30).read().decode())'

kubectl -n torghut exec -i <scheduler-pod> -- python - <<'PY'
import urllib.error
import urllib.request

request = urllib.request.Request("http://127.0.0.1:8183/readyz")
try:
    response = urllib.request.urlopen(request, timeout=30)
except urllib.error.HTTPError as error:
    print(error.code)
    print(error.read().decode())
else:
    print(response.status)
    print(response.read().decode())
PY

kubectl -n torghut exec <ws-pod> -- \
  sh -lc 'wget -qO- http://127.0.0.1:8080/readyz'

kubectl -n torghut logs <ws-pod> --since=30m --tail=200

kubectl cnpg psql -n torghut torghut-db -- \
  -d torghut -X -v ON_ERROR_STOP=1 -A -F '|' -P pager=off -c '<bounded SQL>'
```

### Buy-Only Execution Versus Flat Position SQL

This fixed-window query reproduces the strongest accounting contradiction without printing account labels. It joins
the July 10 execution account to the last position snapshot observed by the audit cutoff.

```sql
SET statement_timeout = '20s';

WITH fills AS (
  SELECT
    alpaca_account_label,
    count(*) FILTER (WHERE filled_qty > 0 AND side = 'buy') AS buy_rows,
    count(*) FILTER (WHERE filled_qty > 0 AND side = 'sell') AS sell_rows,
    max(created_at) AS latest_fill
  FROM executions
  WHERE created_at >= timestamptz '2026-07-10 00:00:00+00'
    AND created_at < timestamptz '2026-07-11 00:00:00+00'
  GROUP BY alpaca_account_label
),
ranked_snapshots AS (
  SELECT
    alpaca_account_label,
    as_of,
    created_at,
    positions::jsonb AS positions,
    row_number() OVER (
      PARTITION BY alpaca_account_label
      ORDER BY as_of DESC, created_at DESC, id DESC
    ) AS row_number
  FROM position_snapshots
  WHERE as_of <= timestamptz '2026-07-14 06:06:33+00'
    AND created_at <= timestamptz '2026-07-14 06:06:33+00'
)
SELECT
  row_number() OVER (ORDER BY fills.alpaca_account_label) AS account_ordinal,
  fills.buy_rows,
  fills.sell_rows,
  fills.latest_fill,
  snapshots.as_of AS latest_snapshot_as_of,
  CASE
    WHEN snapshots.positions IN ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb) THEN 0
    ELSE jsonb_array_length(snapshots.positions)
  END AS position_count
FROM fills
LEFT JOIN ranked_snapshots AS snapshots
  ON snapshots.alpaca_account_label = fills.alpaca_account_label
  AND snapshots.row_number = 1
ORDER BY account_ordinal;
```

Observed result: one account, `819` buy rows, `0` sell rows, and `0` positions in its latest snapshot. The query proves a
database-accounting contradiction, not what the broker independently held.

### Lifecycle Coverage SQL

The bounds below reproduce the audit snapshot. A fresh audit must choose and record a new cutoff rather than silently
replace these bounds with `now()`.

```sql
SET statement_timeout = '20s';

WITH bounds AS (
  SELECT
    timestamptz '2026-06-30 06:06:33+00' AS start_at,
    timestamptz '2026-07-14 06:06:33+00' AS end_at
),
decision_cohort AS (
  SELECT id
  FROM trade_decisions, bounds
  WHERE created_at >= bounds.start_at
    AND created_at <= bounds.end_at
    AND executed_at IS NOT NULL
),
decision_evidence AS (
  SELECT
    d.id,
    EXISTS (
      SELECT 1
      FROM trade_decision_submission_claims c
      WHERE c.trade_decision_id = d.id
    ) AS has_claim,
    EXISTS (
      SELECT 1
      FROM executions e
      WHERE e.trade_decision_id = d.id
    ) AS has_execution,
    EXISTS (
      SELECT 1
      FROM executions e
      WHERE e.trade_decision_id = d.id
        AND e.filled_qty > 0
    ) AS has_fill
  FROM decision_cohort d
),
execution_evidence AS (
  SELECT
    e.id,
    e.filled_qty > 0 AS has_fill,
    EXISTS (
      SELECT 1
      FROM execution_order_events o
      WHERE o.execution_id = e.id
    ) AS has_order_event,
    COALESCE(
      e.execution_audit_json -> 'runtime_ledger_lineage',
      e.execution_audit_json -> 'execution_tca_cost_lineage'
    ) AS lineage
  FROM executions e, bounds
  WHERE e.created_at >= bounds.start_at
    AND e.created_at <= bounds.end_at
),
filled_evidence AS (
  SELECT
    e.*,
    EXISTS (
      SELECT 1
      FROM execution_tca_metrics t
      WHERE t.execution_id = e.id
    ) AS has_tca
  FROM execution_evidence e
  WHERE has_fill
)
SELECT 'claim' AS stage, count(*) FILTER (WHERE has_claim) AS numerator, count(*) AS denominator
FROM decision_evidence
UNION ALL
SELECT 'execution', count(*) FILTER (WHERE has_execution), count(*) FROM decision_evidence
UNION ALL
SELECT 'fill', count(*) FILTER (WHERE has_fill), count(*) FROM decision_evidence
UNION ALL
SELECT 'tca', count(*) FILTER (WHERE has_tca), count(*) FROM filled_evidence
UNION ALL
SELECT 'explicit_cost', count(*) FILTER (WHERE lineage ->> 'explicit_cost_amount' IS NOT NULL), count(*)
FROM filled_evidence
UNION ALL
SELECT 'source_backed', count(*) FILTER (WHERE (lineage ->> 'source_backed')::boolean IS TRUE), count(*)
FROM filled_evidence
UNION ALL
SELECT 'order_event', count(*) FILTER (WHERE has_order_event), count(*) FROM execution_evidence
UNION ALL
SELECT 'filled_order_event', count(*) FILTER (WHERE has_order_event), count(*) FROM filled_evidence;
```

### Candidate Ledger SQL

Both economic time and row-creation time are capped at the audit cutoff so later windows or backfills do not change the
snapshot result.

```sql
SELECT
  hypothesis_id || ' / ' || left(candidate_id, 8) AS candidate,
  count(DISTINCT bucket_started_at::date) AS active_days,
  sum(closed_trade_count) AS closed_trades,
  round(sum(filled_notional), 2) AS filled_notional_usd,
  round(sum(net_strategy_pnl_after_costs), 2) AS net_pnl_usd,
  round(
    10000 * sum(net_strategy_pnl_after_costs) / nullif(sum(filled_notional), 0),
    2
  ) AS net_bps,
  min(bucket_started_at)::date AS first_day,
  max(bucket_ended_at)::date AS last_day
FROM strategy_runtime_ledger_buckets
WHERE (
    blockers_json::text IN ('[]', '{}', 'null')
    OR blockers_json IS NULL
  )
  AND bucket_ended_at <= timestamptz '2026-07-14 06:06:33+00'
  AND created_at <= timestamptz '2026-07-14 06:06:33+00'
GROUP BY candidate_id, hypothesis_id
ORDER BY net_bps DESC;
```

## Limitations

- The final readback was pre-market. Market-open continuity was not observed.
- Direct ClickHouse SQL was not executed because the audit did not inject credentials. TA evidence came from the
  scheduler's ClickHouse-backed status and websocket logs.
- Broker state was observed through Torghut runtime/database surfaces, not an independently authenticated broker pull.
  Building that independent read is a primary design requirement.
- PostgreSQL statistics were not treated as exact bloat measurements.
- The candidate rows were too small and stale to support inference.
- External research informed the normative design but cannot prove Torghut performance.

These limitations strengthen the fail-closed conclusion; none provides a basis to widen capital.
