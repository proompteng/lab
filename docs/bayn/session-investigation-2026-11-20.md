# Bayn PAPER economics and entry recovery: November 16–20, 2026

Status: evidence for the active profitability and reliability investigation. This document records a bounded
historical cut; source, GitOps and fresh runtime evidence remain authoritative.

The [release acceptance companion](release-acceptance-2026-11-21.md) records later CI, publication and
deployed-runtime evidence, with explicit observation windows and unresolved economic qualification.

Later settlement evidence is recorded in [the November 21 addendum](#later-fee-settlement-and-runtime-recovery--november-21-2026).
At its 08:35:10 UTC cut, all $64.03 of observed weekly broker fees were posted: gross trading less broker fees
was -$1,416.03, or -$1,417.717284228 after the original-cut known inference estimate. Both API instances had
returned to READY with EXACT accounting. The earlier pending-fee figures below retain their original cut.

## Scope and provenance

Financial and decision evidence was collected read-only on November 21, 2026, approximately 04:38–04:47 UTC;
runtime checks continued through approximately 04:53 UTC. Financial rows cover
`2026-11-16T00:00:00Z <= occurred_at < 2026-11-21T01:07:10Z`; session dates below use New York time.
The retained account is PAPER. No orders, risk settings, credentials, source records or accounting were changed.

- Inspected source and verified indexed snapshot: `51f39ce495d2230abb3649bac4d86a22db28db04`.
- Verified deployed source: `22424d95916aeb732f8dfd8229c4bf4057532f28`.
- Verified image: `sha256:0a3657848d55129fdccc3b4f739f482982c638dd9e5e532b49a8390d1c5d99da`.
- Kargo commit: `a8607059a5c2c57facd00e5148c03cc5b69e5e02`; Freight:
  `ec42e65c8eac8a4467e9ef95fd8b025f6b0f0da7`.
- Image publication: [successful run 44692317586](https://github.com/proompteng/lab/actions/runs/44692317586).
- SQL ran against `bayn/bayn-db-1`, PostgreSQL database `bayn`, with explicit read-only transactions and
  15–20 second statement limits. `pg_is_in_recovery()` was true.
- Economic source paths inspected: `src/jev/runtime.ts`, `src/jev/strategy-exit-plan.ts`,
  `src/jev/short-exit-plan.ts`, `src/execution/position-protection.ts`, `src/system-assessment/README.md`,
  and the owning README under `services/bayn`.

The SQL checks matched all **863** accounting transactions to **863** stored accounting receipts and **863**
broker fills. Quantity, price, fee, symbol and side agree for all 863. This is a stored-source comparison;
the fixed cut contains exactly one account across transactions, intents and fills, matching the configured
PAPER account. Reusing the queries for a multi-account dataset requires an explicit account predicate.
These stored-source checks do not independently reread every native TigerBeetle transfer. The latest retained reconciliation is
`EXACT` at `2026-11-21T01:07:09.786Z`, with zero discrepancies.

## Economic result

The five sessions contain **169 flat-to-flat equity episodes**, **77 winners and 92 losers**, and
**$3,097,678.70** of entry notional. Gross realized trading P&L is **-$1,352.00**.
There are no crypto accounting transactions in this interval. Equity inventory is flat at both boundaries;
the latest broker position snapshot has zero positions at `2026-11-21T01:07:05.248Z`.

| Session | Episodes | Wins / losses | Entry notional USD | Gross P&L USD | Posted session fees USD | Known inference estimate USD |
| ------- | -------: | ------------: | -----------------: | ------------: | ----------------------: | ---------------------------: |
| Nov 16  |       31 |       15 / 16 |         566,135.12 |       -111.92 |                   11.70 |                  0.410036130 |
| Nov 17  |       15 |        11 / 4 |         281,303.07 |         40.23 |                    5.82 |                  0.306205536 |
| Nov 18  |       16 |         9 / 7 |         300,044.89 |       -176.33 |                    6.21 |                  0.406171794 |
| Nov 19  |       47 |       16 / 31 |         850,170.08 |       -590.70 |                   17.56 |                  0.330870876 |
| Nov 20  |       60 |       26 / 34 |       1,100,025.54 |       -513.28 |                 Pending |                  0.233999892 |

The known inference column is a provider-tariff estimate from the latest immutable quote per request/stage.
It is not an invoice or a complete operating-cost allocation. Historical unknown quotes may be superseded by later
verified quotes; counting every retained quote as current would overstate both unknown usage and expense obligations.
The latest quote set has no unknown usage for November 19 or 20. Earlier sessions retain unknown stage usage:
November 16 has 24 CHART and 24 JEV stages; November 17 has 138 CHART and 136 JEV stages; November 18 has
34 CHART and 3 JEV stages. Missing usage and infrastructure, data and research costs remain unknown.

Retained broker cash/equity moves from **$94,325.06** at `2026-11-16T00:00:43.244Z` to **$92,931.77**
at `2026-11-21T01:07:05.247Z`. The **-$1,393.29** bridge is exact:
**-$1,352.00 gross trading - $41.29 posted broker fees = -$1,393.29**, with no residual at this cut.

The independent broker-observation investigation found two executed November 20 fee witnesses in Activity SSE:
**$0.08 and $22.66**, totaling **$22.74**. At the approximately 04:42 UTC read, REST fee activity still ended
on November 19. These witnesses are provisional for this report: their November 20 immutable REST/ledger posting
was absent. November 20 gross less those witnessed fees is **-$536.02**; subtracting the known inference
estimate gives **-$536.253999892** before unresolved infrastructure, data and research expense.
Neither amount is a fully costed or qualified net-profit result. The pending fee gate preserves accounting authority.

## Loss concentration and original limits

| November 16–20 symbol | Episodes | Gross P&L USD |
| --------------------- | -------: | ------------: |
| INTC                  |       29 |       -425.35 |
| NFLX                  |       45 |       -299.34 |
| AAPL                  |       47 |       -280.17 |
| NVDA                  |       29 |       -210.36 |
| MSFT                  |        7 |       -100.75 |
| AMZN                  |       11 |        -20.58 |
| GOOGL                 |        1 |        -15.45 |

November 20 has 55 long episodes losing **$490.03** and five short episodes losing **$23.25**.
Its 26 winners earn $842.60; its 34 losers lose $1,355.88. Mean winner is $32.41, mean loser is $39.88,
win rate is 43.33%, and gross profit factor is 0.621. Faster or more frequent entries did not establish an edge.

All 169 original funded plans were joined to their entry cycles. Every observed entry fill respected its original
long price ceiling or short price floor and maximum quantity. Every episode's realized gross loss was within its
original modeled stop-loss budget. This comparison does not assign unposted fees or operating costs to episodes,
prove stop execution under future gaps, or establish expected profitability. Sampled current risk policy retains
the $5,000 daily loss cap, $10,000 cumulative drawdown cap and existing position sizing.

Setup attribution is 147 support-recovery episodes / -$1,245.13, 11 base-breakout episodes / -$3.05,
and 11 resistance-rejection episodes / -$103.82. These are realized conditional outcomes, not a causal comparison
of alternative portfolios.

The previously frozen gain/loss bins remain diagnostic. For longs, gain is original estimated target net less
acquisition cost; loss is acquisition cost less estimated stop net. Shorts use original estimated target P&L
and the magnitude of estimated stop P&L.

| November 20 original modeled gain/loss | Episodes | Wins / losses | Gross P&L USD |
| -------------------------------------- | -------: | ------------: | ------------: |
| Below 0.25                             |       23 |        14 / 9 |        -37.76 |
| 0.25–below 0.5                         |       12 |         6 / 6 |        -53.09 |
| 0.5–below 1                            |       16 |        4 / 12 |       -390.73 |
| At least 1                             |        9 |         2 / 7 |        -31.70 |

A new low-ratio cutoff would miss most of this day's losses. The existing 0.70 structural judgment threshold
is not a calibrated probability of target-before-stop. Preserve the frozen strategy and risk policy while
testing an explicitly registered candidate against cash and the actual incumbent with full costs.

## Execution-price diagnostics

The fixed-cohort [read-only execution SQL](sql/session-investigation-2026-11-20-execution.sql) preserves the
original cut, signed conventions, per-query timeouts and benchmark coverage. It reproduced these results when
rerun against the verified standby at approximately `2026-11-21T05:05Z`.

The retained decision rows provide original signal quotes and refreshed execution quotes for all 169 entry episodes
and 413 entry fills. Positive shortfall means a worse fill price than the executable-side IEX benchmark
(ask for buys, bid for sells); negative means a favorable price difference. These are exact-numeric stored-row
comparisons. Signed USD is the sum of `sideSign × quantity × (fill price − benchmark price)`, with buy sign
`+1` and sell sign `−1`. Basis points equal `10,000 × signed USD / sum(quantity × benchmark price)`;
each benchmark uses its own denominator, rather than actual fill notional.
Complete held-source hashes were not independently replayed for this diagnostic, IEX is not an
NBBO benchmark, and PAPER fill behavior remains a limitation.

| Entry cohort                 | Fills | Versus original quote | Versus refreshed quote |
| ---------------------------- | ----: | --------------------: | ---------------------: |
| November 16–20, 169 episodes |   413 | -$931.72 / -3.007 bps |  -$787.15 / -2.541 bps |
| November 20, 60 episodes     |   166 | -$437.69 / -3.978 bps |  -$378.82 / -3.443 bps |

November 20 original-quote-to-first-fill age has median/p95 7.895/12.675 seconds;
refreshed-quote-to-first-fill age is 4.005/9.572 seconds; durable-decision-to-first-fill is 2.829/9.269 seconds.
These intervals include market, routing and fill timing. They are not submission latency or proof of a quote-age
violation at submission. These benchmarks show favorable average filled-entry pricing; they do not isolate
signal quality, adverse selection, omitted opportunities or PAPER simulation effects.

November 20 closing fills also have complete retained-role coverage. Application-close documents were matched by
their exact ordered intent IDs because strategy hashes repeat across replans. Native replacement protection was
matched to its original entry decision and protection levels.

| Closing role         | Fills | Episodes touched |     Signed comparison | Benchmark                   |
| -------------------- | ----: | ---------------: | --------------------: | --------------------------- |
| Native profit target |    58 |               19 |  -$36.68 / -1.084 bps | Original profit limit       |
| Native stop          |    48 |               16 |  +$38.35 / +1.382 bps | Original stop trigger       |
| Application close    |    75 |               29 | -$426.17 / -8.819 bps | Retained closing bid or ask |

Episode counts overlap when an episode has mixed exit types. Native trigger/limit comparisons are not
execution-arrival benchmarks and must stay separate from quote-based shortfall. Application-close quote-to-fill age
has median/p95 4.004/7.346 seconds. Across all five sessions, four of 450 closing fills lack a retained closing quote
and remain unmeasured. These diagnostics do not establish full implementation shortfall or a counterfactual portfolio.

## Deadline and opportunity-loss diagnosis

November 20 retains 83 completed cycles, 116 no-trade cycles and 152 `BLOCKED_UNUSED_ENTRY_EXPIRED` cycles.
A cycle is not an episode: unfilled and other terminal cycles account for the difference from 60 traded episodes.
All 121 stored risk decisions that day are approved.

The 152 expired cycles split into 85 before regular market hours, 13 during regular hours and 54 afterward.
**All remain within the configured IEX entry-session investigation**: current source uses an 08:00–17:00
New York data window, starts eligible entry observations at 08:01:02 and closes entries at 16:55.
Calling the 139 outside regular hours ineligible would hide source-availability failures.

All 13 regular-hours expired cycles have batch plans. Seven make no model request because every candidate is
excluded by source readiness or spread. The other six contain 25 distinct requests and 19 receipts:

| Old cycle start UTC | Original batch result                              | Subsequent reason or failure                                                              |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 15:52:02.020        | Completed 15:52:04.328; expires 15:52:13.523       | INTC target already reached, then spread; fresh execution pricing correctly rejects entry |
| 16:01:02.997        | Original zero-request batch completes 16:01:03.923 | The old cycle later acquires the 16:02 window and five requests before expiring           |
| 16:54:02.034        | Completed 16:54:04.281; expires 16:54:13.555       | NVDA spread fails refreshed pricing                                                       |
| 20:12:03.112        | Completed 20:12:04.993; expires 20:12:13.748       | MSFT spread fails; the old cycle later acquires the 20:13 window and one request          |
| 20:38:02.014        | Completed 20:38:14.040; expires 20:38:14.844       | Next observed controller projection is 20:38:16.225, after expiry                         |
| 20:39:02.256        | Completed 20:39:07.156; expires 20:39:13.925       | MSFT spread fails refreshed pricing                                                       |

The two next-window acquisitions are a concrete recovery problem. At 16:02:02.752 the old 16:01 cycle opens
five requests, then terminates at 16:02:03.504. At 20:13:02.766 the old 20:12 cycle opens one request, then
terminates at 20:13:03.342. All six lack provider receipts; their latest CHART and JEV cost quotes are explicitly
`NOT_DISPATCHED`, with zero estimated provider cost. They consume the next source window before the successor can use it. Repair ownership and the
original-cycle deadline boundary; retain the ten-second inference budget and every pricing and financial check.

The remaining completed receipts in these cycles are on time. Several valid pricing rejections must remain
rejections: a reached profit target or widened spread cannot become an authorized entry. The 20:38 completion-to-owner
delay is evidence for tracing resume/persistence latency, not proof that the rejected trade would have made money.

Across completed receipts, median / p95 elapsed request time improves from **1.758 / 4.467 seconds** on November 18
to **0.659 / 1.408 seconds** on November 20. This measures the receipt's started/completed interval, not complete
market-event-to-broker-acknowledgement latency. The realized losses rose while this component became faster.

## Runtime performance baseline

Mimir measurements cover November 20, 13:00–22:00 UTC, for deployed source
`22424d95916aeb732f8dfd8229c4bf4057532f28`. These are successful-operation histogram estimates;
failed, interrupted and never-started work require their separate denominators. Nested stages overlap.

| Stage                             | Estimated p50 | Estimated p95 |
| --------------------------------- | ------------: | ------------: |
| Broker capture                    |        4.32 s |        9.54 s |
| Broker publication                |        321 ms |        489 ms |
| Generation pass                   |        215 ms |        2.29 s |
| Reconciliation persistence        |        770 ms |        1.50 s |
| Intent reconciliation             |        754 ms |        1.59 s |
| Broker submission                 |        374 ms |        1.03 s |
| Valkey get                        |         21 ms |         46 ms |
| Valkey queue                      |       0.50 ms |       0.95 ms |
| PostgreSQL connection acquisition |       0.50 ms |       0.95 ms |

The two execution-controller pods averaged 0.578 and 0.618 CPU cores, with peak five-minute rates of
0.933 and 1.071 cores. Peak container working sets were 734.49 and 1,139.50 MiB against each pod's
eight-core and 3,072 MiB limits. Both controller containers had zero measured CPU throttled-period ratio.
The execution scheduler's estimated p95 delay was 38.76 ms. These measurements establish useful headroom
for this session; they do not prove leak-free operation or a whole-path deadline guarantee.

Current high throttle ratios seen on Valkey and PostgreSQL pod aggregates belonged primarily to exporter
or backup sidecars. The data does not support increasing controller, database or cache limits to solve the
observed economic or fee-settlement problems. Current pool and cache queue measurements also show no saturation.

A follow-up on the same source and nine-hour cut grouped the broker-read histograms by `operation` and
`outcome`. Successful order reads had estimated median/p95 0.670/1.607 seconds, versus 0.081/0.218 seconds
for account reads. The order-read headers stage measured 0.280/0.496 seconds and its body stage
0.382/0.919 seconds. These nested quantiles cannot be added, and the operation includes both recent/open
order probes and complete history pages. They identify a slower read class without proving the cause of
an individual expired cycle. The source already overlaps independent reads and reuses only verified
history; complete before/after history checks preserve the account snapshot's authority.

To reproduce stage quantiles, query the existing Mimir endpoint at `2026-11-20T22:00:00Z`:

```promql
histogram_quantile(0.95,
  sum by (le, stage) (increase(bayn_operation_duration_seconds_bucket{
    service="bayn-execution-controller",
    source_revision="22424d95916aeb732f8dfd8229c4bf4057532f28",
    outcome="succeeded"
  }[9h]))
)
```

Replace `0.95` with `0.5` for the median; the corresponding `_count` increase gives estimated observation counts.
For container metrics, retain `namespace="bayn"`,
`pod=~"bayn-execution-controller-45c7948966-.*"`, and `container="execution-controller"`.
Use `max_over_time(container_memory_working_set_bytes{...}[9h])` for peak working set and the ratio of
`increase(container_cpu_cfs_throttled_periods_total{...}[9h])` to
`increase(container_cpu_cfs_periods_total{...}[9h])` for throttled periods. Preserve per-container attribution.

## Streaming observability gap

Both live Flink jobs were `RUNNING/READY` at approximately `2026-11-21T04:53:35Z`, with four TA and eight
market-data archive TaskManagers running and no current container restarts. The latest successful checkpoint ages
were 32.4 and 16.5 seconds, respectively; checkpoint durations were 1.93 and 0.986 seconds. The preceding six hours
had zero observed failed checkpoints or job restarts. Representative direct TaskManager exporters reported zero
pending records and zero backpressure. Broker-feed readiness was one, with zero observed failures over six hours.

However, the existing metrics Services selected only JobManagers. The TaskManager exporters exposed lag,
pending-record and backpressure series that were absent from Mimir. This establishes missing observability;
it does not establish a pipeline outage, and an absent or NaN lag series must never be interpreted as zero lag.

The repair adds separate metrics Services for the TA and archive TaskManagers, using the existing named
`metrics` port and Alloy endpoint discovery. Existing JobManager targets remain independent. Both affected
Kustomize subtrees render successfully, and live selectors match four TA and eight archive TaskManagers.
The complete Torghut root subsequently rendered successfully with checksum-verified official Helm 3.19.1
and `kubectl kustomize --enable-helm --helm-command <verified-helm3>`. The rendered 67 resources contain
exactly four independent JobManager/TaskManager metrics Services and exclude the retired trading workloads.
This verifies rendered configuration, not deployment or live metric coverage.
Deployment must follow the existing `torghut-release:torghut` cohort through Kargo and Argo, including its normal
checkpoint/savepoint lifecycle. It must not reactivate the retired Torghut API or trading scheduler.

After the generated deployment converges, verify the discovered target count against actual running replicas:

```promql
count by (service) (
  up{job="torghut", namespace="torghut", service=~".*-taskmanager-metrics"} == 1
)
```

Also verify that `flink_taskmanager_job_task_operator_pendingRecords` and
`flink_taskmanager_job_task_backPressuredTimeMsPerSecond` have actual samples, that existing JobManager targets
remain healthy, and that both jobs complete fresh checkpoints. The pre-deployment expected target counts are
four TA and eight archive; autoscaling or a later replica change must be reflected rather than hidden.

## Qualification and action boundaries

The inspected database contains eight registrations, all `bayn.operational-registration.v1`, with the latest
calendar ending November 13, and zero `system_assessment_receipts`. It supplies no completed, current
fully costed paired qualification for November 16–20. This is scoped database evidence, not a claim about every
external research artifact. Cash or an unexecuted hypothetical portfolio cannot replace the actual incumbent.

Priority actions supported by this cut:

1. Fix the old-cycle next-window admission defect and prove the original deadline, successor ownership,
   at-most-once provider calls and recovery behavior with a focused regression.
2. Expose pending broker fee confirmation accurately while preserving the existing settlement gate.
   The observed provider transport works; the actionable issue is delayed authoritative fee materialization.
3. Restore TaskManager metrics coverage and verify the new targets and successful checkpoints after GitOps rollout.
4. Retain the economic baseline above through rollout. Verify deployed code and runtime behavior separately
   from prospective profitability. Additional throughput is useful only with a qualified economic comparison.
5. Obtain complete operating-cost evidence and register untouched prospective sessions, candidate identity,
   conditional support and actual-incumbent controls before claiming an edge. Preserve failed attempts.

## Reproduction

Run through the authorized Agent Shell `kubectl_admin` route. The SQL is read-only; it does not query credentials.
Use the observed standby or another explicitly verified read replica. Preserve the dates when reproducing this cut.

```sh
kubectl exec -i -n bayn bayn-db-1 -c postgres -- \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d bayn -At <<'SQL'
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
SELECT symbol,sum(quantity_delta_atoms) AS starting_quantity
FROM accounting_transactions WHERE occurred_at<'2026-11-16T00:00:00Z' AND symbol NOT LIKE '%/%'
GROUP BY account_id,symbol HAVING sum(quantity_delta_atoms)<>0;
WITH tx AS MATERIALIZED (
 SELECT account_id,transaction_id,occurred_at,symbol,side,quantity_delta_atoms,notional_micros,realized_pnl_micros
 FROM accounting_transactions WHERE occurred_at>='2026-11-16T00:00:00Z'
 AND occurred_at<'2026-11-21T01:07:10Z' AND symbol NOT LIKE '%/%'
), inventory AS (
 SELECT *,sum(quantity_delta_atoms) OVER(PARTITION BY account_id,symbol ORDER BY occurred_at,transaction_id) AS ending_quantity FROM tx
), grouped AS (
 SELECT *,sum(CASE WHEN ending_quantity-quantity_delta_atoms=0 THEN 1 ELSE 0 END)
 OVER(PARTITION BY account_id,symbol ORDER BY occurred_at,transaction_id) AS episode FROM inventory
), directed AS (
 SELECT *,first_value(side) OVER(PARTITION BY account_id,symbol,episode ORDER BY occurred_at,transaction_id) AS entry_side FROM grouped
), episodes AS (
 SELECT account_id,symbol,episode,entry_side,min(occurred_at) AS opened_at,max(occurred_at) AS closed_at,
 sum(quantity_delta_atoms) AS remaining_quantity,sum(realized_pnl_micros) AS gross_pnl,
 sum(notional_micros) FILTER(WHERE side=entry_side) AS entry_notional
 FROM directed GROUP BY account_id,symbol,episode,entry_side
)
SELECT (opened_at AT TIME ZONE 'America/New_York')::date AS session_date,count(*) AS episodes,
count(*) FILTER(WHERE gross_pnl>0) AS wins,count(*) FILTER(WHERE gross_pnl<0) AS losses,
sum(gross_pnl)/1e6 AS gross_usd,sum(entry_notional)/1e6 AS entry_notional_usd,
count(*) FILTER(WHERE remaining_quantity<>0) AS open_episodes FROM episodes GROUP BY 1 ORDER BY 1;
COMMIT;
SQL
```

Episode construction first verifies zero starting equity inventory, partitions by account and symbol, orders
by effective timestamp and transaction identity, and starts a new episode only from flat. Sum signed quantity
to verify every resulting episode closes. Native stored broker inventories may contain separate historical
crypto adjustments; do not reinterpret raw all-history transaction deltas as current broker positions.

Additional compact checks, each inside `BEGIN READ ONLY; SET LOCAL statement_timeout='15s'; ... COMMIT;`:

```sql
-- Stored accounting, receipt and fill coverage; the final count compares all five fill fields.
SELECT count(*) AS transactions, count(ar.receipt_id) AS receipts, count(f.event_id) AS fills,
 count(*) FILTER (WHERE t.quantity_atoms=f.quantity_atoms AND t.price_atoms=f.price_atoms
  AND t.fee_micros=f.fee_micros AND t.symbol=f.symbol AND t.side=f.side) AS matching_fills
FROM accounting_transactions t
LEFT JOIN accounting_receipts ar ON ar.broker_event_id=t.broker_event_id AND ar.intent_id=t.intent_id
LEFT JOIN fills f ON f.event_id=t.broker_event_id
WHERE t.occurred_at>='2026-11-16T00:00:00Z' AND t.occurred_at<'2026-11-21T01:07:10Z';

-- Attribute broker expenses to their fee session, separately from the cash posting date.
SELECT fee_date, count(*), sum(net_amount_micros)/1e6 AS signed_usd
FROM broker_fee_accounting WHERE fee_date BETWEEN '2026-11-16' AND '2026-11-20'
 AND first_observed_at<'2026-11-21T04:47:00Z' GROUP BY fee_date ORDER BY fee_date;

-- Quote revisions are immutable; take only the latest retained revision per request and stage at this cut.
WITH latest AS (
 SELECT DISTINCT ON (request_id,provider_stage) *
 FROM inference_expense_quotes WHERE session_date BETWEEN '2026-11-16' AND '2026-11-20'
 AND created_at<'2026-11-21T04:47:00Z'
 ORDER BY request_id,provider_stage,created_at DESC,quote_hash DESC
)
SELECT session_date,provider_stage,payload->'line'->>'usageStatus' AS usage_status,count(*),
 sum((payload->'line'->>'estimatedCostPicoUsd')::numeric)/1e12 AS estimated_usd
FROM latest GROUP BY 1,2,3 ORDER BY 1,2,3;

-- Preserve request and batch boundaries; a cycle can own more than one batch.
SELECT c.created_at AS cycle_created_at,b.payload->>'observedAt' AS batch_observed_at,
 b.payload->>'expiresAt' AS batch_expires_at,r.payload->>'completedAt' AS batch_completed_at
FROM autonomous_cycles c JOIN jev_batch_plans b USING(cycle_id)
LEFT JOIN jev_batch_results r USING(batch_id)
WHERE c.execution_session_date='2026-11-20' AND c.terminal_reason='BLOCKED_UNUSED_ENTRY_EXPIRED'
 AND c.created_at BETWEEN '2026-11-20T14:30:00Z' AND '2026-11-20T21:00:00Z'
ORDER BY c.created_at,b.payload->>'observedAt';

SELECT c.created_at AS cycle_created_at,q.symbol,q.payload->>'observedAt' AS request_observed_at,
 q.payload->>'expiresAt' AS request_expires_at,r.payload->>'startedAt' AS started_at,
 r.payload->>'completedAt' AS completed_at,r.payload->'outcome'->>'status' AS outcome
FROM autonomous_cycles c JOIN jev_evaluation_requests q USING(cycle_id)
LEFT JOIN jev_evaluation_receipts r USING(request_id)
WHERE c.execution_session_date='2026-11-20' AND c.terminal_reason='BLOCKED_UNUSED_ENTRY_EXPIRED'
 AND c.created_at BETWEEN '2026-11-20T14:30:00Z' AND '2026-11-20T21:00:00Z'
ORDER BY c.created_at,q.symbol,q.payload->>'observedAt';

-- Bound to a suspect minute; output only diagnostic reason and timing, not full controller payloads.
SELECT recorded_at,status->'last_pass'->'readiness'->>'reason' AS reason,
 status->'last_pass'->'readiness'->>'message' AS message,
 status->'last_pass'->>'observedAt' AS pass_observed_at,
 status->'last_pass'->>'nextWakeAt' AS next_wake_at
FROM execution_controller_observations
WHERE recorded_at>='2026-11-20T16:01:00Z' AND recorded_at<'2026-11-20T16:02:15Z'
ORDER BY observation_id;
```

Raw account identifiers, provider payloads, credentials and per-trade private packets are deliberately absent
from this report. SQL outputs remain private operational evidence. No strategy threshold, risk limit or
qualification criterion is inferred from these realized outcomes.

## Post-merge verification and follow-up findings

The observations below were collected after the economic cut above. Times in this section are UTC.
They concern release behavior and prospective research compatibility; the historical economic results remain fixed.

[PR #16097](https://github.com/proompteng/lab/pull/16097) merged as
`87a8d928433f476530a2323b9afc8166e1c261a3`. Its exact-head CI passed 5,957 unit tests
with zero failures; the separate database, ledger, streaming, replay and formal release gates also passed.
The [Bayn main build](https://github.com/proompteng/lab/actions/runs/44871171689) published all three
images for both amd64 and arm64. Kargo promoted Freight `1ae75901530187362472b4806b5b8b6298eb666f`
at 06:10:13 on November 21, and its verification analysis completed successfully at 06:10:31.
Argo converged at generated branch commit `f8744abdce0573d35c5623572371343686778123`.

Both API replicas reported the intended embedded source and OCI index identity. Their actual Node processes
ran on arm64/Linux and x64/Linux respectively; the Pod image IDs reported index digests, so this observation
does not independently prove each platform child-manifest digest. The activation hook succeeded, controller
epoch advanced from 452 to 453, and a fresh durable WAITING pass completed at 06:12:30. Both APIs exposed
`BROKER_CASH_FEES_PENDING` while accounting remained EXACT. The existing fee gate and research authority
remained in force. This is live verification of status fidelity and successor activity, rather than evidence
of additional trading profit or an observed improvement during an open market session.

The end-to-end checks exposed three additional issues:

- The separate [OpenCode main image build](https://github.com/proompteng/lab/actions/runs/44871171425)
  failed its native amd64 startup test twice, including one controlled same-source retry. The prior healthy
  deployment remained selected. The second attempt reproduced the 25-second readiness timeout without the
  first attempt's transient cache-download error. Logs did not identify whether the original stall occurred
  in the redundant version process or the server itself. The startup correction removes that duplicate
  bootstrap, proves the live authenticated version, and propagates child failure promptly. Exact native
  amd64 and arm64 image tests remain required; a latency saving has not been established.
- All four TA and eight archive TaskManager metrics targets became visible. Their 41,717 post-relabel
  samples per scrape raised Alloy's observed working set from 139.7 MiB to 225.7 MiB. During Flink handover,
  Alloy was OOM-killed at 06:08:09 under its 256 MiB limit. The scoped capacity correction requests 256 MiB
  and allows 512 MiB while preserving metric content. Acceptance requires fresh Flink checkpoints and live
  target, collector-memory, restart and remote-write checks through the corrected rollout.
- Bayn's current Flamingo admission policy still pinned the former serving image after the reviewed
  [vLLM upgrade](https://github.com/proompteng/lab/commit/66badfc269c0cbaa69c150cd46cb35475e7b6890).
  Read-only live identity matched the committed new image and the existing model checkpoint. The prospective
  correction must freeze historical policy variants independently, admit the new exact image for new runs,
  and preserve signed run hashes, receipts and budgets. Each prospective run still requires its own valid
  approval through the existing workflow. This compatibility finding does not attribute the November 20
  trading losses to the research service.

The operational repairs and prospective policy correction are tracked in
[PR #16098](https://github.com/proompteng/lab/pull/16098). Their deployment and runtime acceptance must be
recorded separately from the completed first Bayn release above.

The Torghut post-deploy workflow previously accepted the rollout without testing collector health. Its
runtime observation window, 06:07:56–06:08:50, overlapped the Alloy OOM at 06:08:09. The follow-up adds
acceptance checks bound to the verified Argo revision, promoted manifests, current process identity and
actual TaskManager replicas. It verifies collector capacity, absence of retained rollout OOM/restarts,
current metric targets and fresh samples, and advancing remote-write delivery without drops or counter
regression over two scrape intervals. Transient probe failures retain the original process and observation
history. A bounded read-only run against the original deployment correctly rejected its retained OOM.
Deleted-Pod history and drops before the first observation of a reused collector remain explicit limits.

At follow-up source `77163050aeea08c635f31b3bdcafa08a02087260`, the
[core Bayn CI](https://github.com/proompteng/lab/actions/runs/44875746366) passed. The separate
[native build](https://github.com/proompteng/lab/actions/runs/44875746373) passed on amd64 with 30 assertions
but failed on arm64 with the unchanged 25-second readiness timeout. The passing test's 53.273-second total
includes two launches and cleanup; it is not a readiness latency measurement. The failed runner showed no
measured CPU throttling or restarts and no memory-limit saturation, but these observations do not identify
the cause. The subsequent test-only diagnostics record bounded spawn, native readiness and gateway phases
without exposing credentials or changing the original deadlines, retry budgets, ownership or assertions.
Both architectures must pass on the final source before release.

The subsequent [native run at `6219a192`](https://github.com/proompteng/lab/actions/runs/44878792846)
passed both architecture jobs with 30 native assertions each. The diagnostic gateway-readiness observations
were 17.911 seconds initially and 1.237 seconds on restart for arm64, and 14.472/1.213 seconds for amd64.
Process handles were acquired in 45/18 ms and 25/7 ms, respectively. These observations locate the time
after process acquisition for this passing run; they neither explain the previous timeout nor establish
a production latency improvement. All original deadlines and authentication assertions remained in force.

Broader Torghut CI exposed a stale universe assertion from before the reviewed
[equity-short source extension #15946](https://github.com/proompteng/lab/pull/15946). The runtime had already
kept 16 WebSocket bar symbols and six completed-REST-only bar symbols, but the test compared their shared
22-symbol `SYMBOLS` field with the old 16-symbol WebSocket set. The corrected contract verifies both exact
sets, the complete shared allowlist and quote/trade coverage, and the unchanged 30-stream WebSocket budget.
Runtime manifests and trading eligibility are unchanged.

### Main publication and native startup follow-up

PR #16098 merged as `c217c1ddcce8f87d6c4306de27a1894cf8afe4ec` at 07:42:59 UTC on November 21.
Its final PR source `3ce84941e941e5a1d7f5341b465dc32b6d2e49f5` passed both native image jobs and
all required CI gates. The subsequent [main OpenCode build](https://github.com/proompteng/lab/actions/runs/44881526170)
failed on both architectures. The previous healthy OpenCode deployment remained selected; a passing PR build
did not establish that the intermittent startup failure was resolved.

The new diagnostic records put the arm64 failed startup at 07:49:03.937–07:49:28.952 and amd64 at
07:49:38.024–07:50:03.036. Child acquisition took 54 ms and 26 ms. Arm64 made three native requests,
with two early transport failures and no HTTP response; amd64 made two, with one early transport failure
and no HTTP response. Each last request remained unanswered until the original 25-second budget expired.
On amd64, scoped cleanup then remained pending until Bun's 90-second test ceiling killed a dangling process.

The pinned [OpenCode server source](https://github.com/anomalyco/opencode/blob/bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1/packages/server/src/process.ts)
awaits listening on an initially handler-free server before attaching its request dispatcher. Its exact
`@effect/platform-node` 4.0.1 dependency has the same listen-before-handler ordering. The dependency's npm
archive SHA-512 was checked against that upstream commit's `bun.lock`. An isolated loopback reproduction
on Node 24.11.1 and Bun 1.4.2 observed one early request event with zero handlers: that first request stayed
unanswered after handler installation, while a second request returned HTTP 200. This proves an exposed
failure mechanism, not the exact phase or syscall of either historical failed request.

The follow-up therefore bounds each complete authenticated identity probe, including JSON validation, to
one second within the unchanged 25-second total readiness budget. Only a probe timeout, transport failure
or authenticated and version-verified HTTP 503 may retry. Authentication errors, wrong versions, other HTTP
errors, defects and child exits retain their existing terminal behavior. Retries use the same owned process.
Scope shutdown now allows 25 seconds after SIGTERM, preserving the native library's 20-second graceful
drain, before escalating to SIGKILL. This is not a hard exit-time guarantee for uninterruptible kernel I/O.

Before the correction, a never-answering probe regression failed because no second probe was attempted,
and a real child ignoring SIGTERM required the test's independent cleanup watchdog. With the correction,
all 13 startup/shutdown tests passed, including unchanged authentication and whole-budget negatives, and
the resistant child was reaped in 25.028 seconds without its watchdog. The broader local suite passed 414
tests with 77 explicit environment-gated skips. Native CI and live release acceptance remain separate gates.

### Shared storage latency observed during publication

The failed native startup phases overlapped substantial Ceph-backed runner I/O pressure. Arm64's one-minute
RBD mean write latency was approximately 1.7–3.4 seconds, with estimated queue depth near 20. The amd64
runner's corresponding mean read latency was 7.834 seconds and mean write latency 1.858 seconds. Both
had zero observed CPU throttling and approximately 1 GiB working sets under 32 GiB limits. These are
scrape-window measurements, not independent measurements of each 25-second request; they establish
correlation, not request-specific storage causation.

The live TA and archive jobs also experienced slow checkpoints while still on the earlier `87a8d928` cohort,
with no pending promotion or savepoint. TA checkpoint 168640 eventually completed; the coordinator log
reported 754.670 seconds from its recorded trigger timestamp to the completion log. Read-only JobManager
thread dumps at
08:05:01 showed TA waiting for S3 `putObject` response headers while creating a checkpoint directory marker,
and archive waiting for `completeMultipartUpload` while finalizing checkpoint metadata. RGW logs matched
the next TA checkpoint's metadata path: an existence-probe HEAD took 6.952 seconds, multipart initiation
2.604 seconds and metadata PUT 15.564 seconds. The HEAD's 404 was a normal absence probe, not a failed
checkpoint. This directly identifies slow S3 request completion on the checkpoint path.

The exact live [Flink 2.2.1 checkpoint coordinator](https://github.com/apache/flink/blob/450c63e961805a90aa18cb815d6b412f44303b9b/flink-runtime/src/main/java/org/apache/flink/runtime/checkpoint/CheckpointCoordinator.java)
records its proposed timestamp before planning and queued coordinator work. It creates the pending checkpoint
and timeout before storage-location initialization and actual task triggering. The [configured TA timeout](https://github.com/proompteng/lab/blob/87a8d928433f476530a2323b9afc8166e1c261a3/argocd/applications/torghut/ta/configmap.yaml)
is 300,000 ms, also verified from the live ConfigMap and Flink REST. The approximately 553.8-second interval
before the pending-checkpoint/Triggering log was outside that timer; it is not an isolated measurement of
S3 initialization or executor queue time. Checkpoint-ID allocation and old-checkpoint cleanup use the
JobManager I/O executor. The earlier dumps showed one such worker, but its configured default depends on
the JVM processor count and the numeric pool maximum was not directly measured. Slow cleanup remains a
possible amplification path, with no captured queue depth. No executor or timeout setting was changed.
The [later phase diagnosis](release-acceptance-2026-11-21.md#measured-checkpoint-phases) records the explicit
phase boundaries, recovered checkpoint ages and incident alert evidence.

At 08:08, the observed source lag and task backpressure were zero despite slow checkpoint completion. The
deployed `TorghutSignalPipelineCheckpointsStalled` age alert independently covered this case: the loaded Mimir
rule was healthy and 14 sampled observations showed TA FIRING between 07:53:00 and 08:06:30. This is not
a claim of continuous firing or email delivery. Archive reached pending, and by 08:15:33 both checkpoint
ages were recent (TA 35.3 seconds, archive 42.1 seconds), with the rule inactive. No additional alert was
needed for the demonstrated condition.

At 08:06, five-minute measurements showed the three Turin OSDs' shared BlueStore DB device at 99.76%
busy, estimated queue depth 13.46 and 51.75 ms mean writes. Their BlueFS fsync means were 110–122 ms,
and OSD mean writes were 3.65–5.08 seconds. Ceph still reported HEALTH_OK: durable health did not imply
low latency. The exact load share attributable to each client remains unproved. The separate Nix download
concurrency trial must finish and retain its baseline pair before the lower-concurrency candidate, with
checkpoints still advancing and no new failures. The identified S3 delay remains a comparison confound;
no runner-count, storage durability, scrub, checkpoint or financial database setting was changed.

## Prospective profitability qualification

A bounded read-only follow-up at source `87a8d928433f476530a2323b9afc8166e1c261a3` found eight retained
registrations, all operational reliability studies. The latest registered window was November 13 and used
Jev v40. Seven operational receipts existed: six INCONCLUSIVE and one REJECTED. There were no economic
registrations or system-assessment receipts, and no prospective registration for November 16–20 or the
serving v41 policy. Registration, capture and assessment are explicit operator commands; these observations
alone do not distinguish an omitted invocation from a failed attempt.

The existing economic contract requires two to four policies with distinct account bindings, while retained
authority generations contain only one distinct account. Its `DEPLOYED_BAYN` control is explicitly the frozen
pre-Jev control, rather than the current serving Jev incumbent. An actual-incumbent comparison therefore
requires an explicit policy identity and genuinely distinct matched account evidence. The retained history
origin already contains six economic attempts, making the next attempt seven; operational history makes the
next attempt nine. Neither sequence may be reset, and a historical period cannot be registered retrospectively.

[Draft PR #16095](https://github.com/proompteng/lab/pull/16095), inspected at
`3a9ae952860a87886251f299e2b7f311e38adf8d`, owns the native calendar, exact broker source-pair lineage,
fee-ledger verification and native-arrival frontier work. That draft does not supply an actual-incumbent
comparison, another account binding or a prospectively registered profitable period. Those prerequisites,
complete cost allocation and original approval requirements remain separate from these runtime repairs.

The follow-up also reproduced a retained-reader defect: the original current validator rejected all four
stored v37 registrations while accepting the four v38/v40 registrations. That blocked replay of six of the
seven retained operational receipts even though the historical protocol schema retained v37. The repair
accepts v37 only in the retained reader and only with the exact historical default parameters. Current
registration and execution admission remain unchanged.

A read-only validation of the same eight live immutable registrations with the repaired reader passed all
eight, and every recomputed registration hash matched its stored key. A fixed historical fixture exercises
the public receipt reader and preserves its INCONCLUSIVE / NOT_ASSESSED outcome, including the original
registration, source-cut and receipt hashes. Forged or altered v37 parameters remain rejected. The subsequent
full graph readback found one further retained-only boundary: a v37 protocol inside archived position-hold
evidence was still being decoded with the current protocol schema. Its immutable archive bytes and original
protocol hash matched the historical registration; this was not missing or corrupted evidence.

Review also required retaining the original long-only evidence domain: positive held quantity and cost,
only the original funded-plan versions, and no protection-evidence marker introduced later under v41.
Resealed short and later-marker fixtures first reproduce through the general current calculation, then
fail the historical decoder. Current long and short execution admission remain unchanged.

The narrow retained-hold correction then replayed all seven actual immutable graphs through the source
reader with exact stored receipt, registration and source-cut hashes. The replay made 1,650 archived-record
reads; all 1,608 distinct referenced records existed. Six outcomes remain INCONCLUSIVE / NOT_ASSESSED.
The remaining outcome stays REJECTED / NOT_ASSESSED, including its 550 UNBOUND_CONTROLLER_BUILD
findings and INCOMPLETE_SAFETY_AUDIT finding. Current execution, registration and assessment admission
remain unchanged. This was a bounded SELECT-only source-function replay; it did not run a new assessment,
persist a receipt, grant authority or independently prove the deployed HTTP reader. No historical outcome
was upgraded, and replay compatibility does not establish economic qualification.

## Native follow-up validation after the combined correction

At combined head `dd816275ac206c48aa5f2b013f72a441a1b0298b`, the ARM native job
[136787823098](https://github.com/proompteng/lab/actions/runs/44884858281/job/136787823098)
recovered initial readiness in 17.878 seconds after 11 cancelled probes. Restart readiness took 1.230 seconds.
The whole test nevertheless reached its unchanged 90-second limit with ten assertions. That count places
its last assertion at the second inference outcome; it does not establish whether the outcome assertion or
subsequent receipt validation failed before cleanup. The first shutdown interval was approximately 25 seconds.
The second request retained the first request's absolute 60-second deadline, so a late failure followed by
scope cleanup can hide its cause behind the outer test timeout. No request window or test deadline was extended.

Bounded test-only lifecycle markers now report inference outcome before assertions, child-exit observations,
shutdown boundaries and at most 32 native operations classified by fixed purpose. They omit authentication,
session identifiers, request bodies and provider payloads. They record assertion exit before outer cleanup so
subsequent native failures are inspectable. These diagnostics are not an additional production repair.

A local x64 preflight verified the exact pinned npm archive SHA-512 and unchanged extracted binary bytes,
then invoked that binary through an existing glibc loader. The full native lifecycle passed all 30 assertions;
with complete instrumentation it took 13.122 seconds. Provider calls used the in-process test stub only.
This validates the harness and diagnostics locally, not Nix packaging, ARM behavior or the cause of the CI failure.
The native CI gates remain required on the final source before release.

The same combined head's amd64 native job passed all 30 assertions in 37.250 seconds. It recovered initial
readiness in 16.681 seconds after 13 cancelled probes and restarted in 1.211 seconds. This confirms recovery
of unanswered probes in that run, while the ARM lifecycle failure above remains a separate unresolved observation.

## Later fee settlement and runtime recovery — November 21, 2026

This addendum preserves the original 04:47 UTC evidence cut. New SELECT-only evidence, bounded at 08:35:10 UTC, confirms that the two November 20 fees previously witnessed through Activity SSE became canonical REST/ledger records: **$22.66 and $0.08, totaling $22.74**. Both REST reads were HTTP 200 at **07:56:15.222 UTC**; ledger posting timestamps are **07:56:23.828326** and **07:56:23.865249**. Neither record has a match correction.

The broker cash view lagged those fee records. Retained cash/equity remained **$92,931.77** through **08:22:04.144**, then first reflected **$92,909.03** at **08:22:35.170**. The approximately 26-minute lag produced 127 retained DISCREPANCY reconciliation observations from **07:56:23.415** through **08:22:12.509**. The exact restriction-triggering receipt contains only a CASH discrepancy: expected 92,909,030,000 micros versus observed 92,931,770,000, a $22.74 difference. The first retained EXACT reconciliation followed at **08:22:41.438**. The safety audit shows effective OBSERVE with active kill at version 1875, a clear OBSERVE successor at 1876, then PAPER reactivation at 1877 only after a fresh exact reconciliation. These were the existing controller's durable recovery transitions; the investigation issued no writes.

| November 16–20 economic bridge                             |                  USD |
| ---------------------------------------------------------- | -------------------: |
| Gross realized trading                                     |            -1,352.00 |
| Canonically posted broker fees, ten records                |               -64.03 |
| Broker cash/equity change, $94,325.06 to $92,909.03        |            -1,416.03 |
| Original-cut known inference tariff estimate               |         -1.687284228 |
| Gross less posted broker fees and known inference estimate | **-1,417.717284228** |

The inference total was independently re-summed from 8,674 latest request/stage quotes at the original 04:47 cut: **1,687,284,228,000 pico-USD**, all bound to exactly one configured PAPER account with no missing request-generation binding. This is an estimate, not a provider invoice. Earlier-session unknown usage and unallocated infrastructure, data and research expense remain unresolved. The final row is therefore a known-cost result, not fully costed net profit or economic qualification. November 20 alone is now canonically **-$536.02 after broker fees**, or **-$536.253999892 including its original-cut known inference estimate**.

Fill coverage remains **863 fills** from November 16; the last execution is November 20 at **20:54:48.067**, last observed at **20:54:48.182**. There were zero fills executed from November 21 onward and zero newly observed fills after the original evidence cut. Settlement did not revise the original trading cohort.

### Authority and runtime provenance

Both existing API pods on amd64 and arm64 returned HTTP 200, **operational READY**, broker execution eligible and accounting EXACT at **08:33:15–17 UTC**. They were still source **87a8d928433f476530a2323b9afc8166e1c261a3**, image **sha256:33db25f066060f7cca1d0394f457169cc3cd70ac8f8f48b4b2d79e2c8460088e**; c217 publication had not promoted.

The immutable Research mandate request remains **6856f071e54529227ea48fa7b077506209ffd887c939d7351e948d7e03020130**, plan **033c6388b975b4f460393b26161dd3651b1c4c80451fc2d3400a950c55af9660**. The old and recovered generations have the same sandbox account/broker identity, maximum PAPER capability, Jev v41 strategy behavior/parameters/protocol, risk-policy hash and plan hash. The request's zero-open-order/zero-position fields are activation preconditions, not post-activation portfolio limits. The configured build lineage retains the authored request (source 503cb2d...) and binds the already reviewed deployed 87a8d928 source/image. There is no new mandate or changed trading policy.

Recovery lineage is old generation **6e2cc4028f3c631ca1741768a82ef2e770e9811387b1d17d523a910fafd6039c** → clear OBSERVE **6961e2d590812b09eed14965bcf6e8871fa4c4c1cb5da3e3c82444b4063b5ba0** at 08:22:42.697450 → recovered PAPER **412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571** at 08:22:44.908044. The new generation's bound reconciliation at **08:22:43.635** is EXACT, with zero discrepancies and equal expected/observed hashes; its stored content hash matches the generation binding.

The durable controller remains epoch **453** and progressed from sequence **365858** to **365859**, SUCCESS/WINDOW_CLOSED. Its next eligible window is **2026-11-23T13:01:02Z**. The generation changed as part of exact-reconciliation recovery; it must not be reported as unchanged. This observed recovery does not prove strategy profitability.

### Reproduction

The bounded SELECT-only queries are retained in
[`sql/fee-settlement-2026-11-21.sql`](sql/fee-settlement-2026-11-21.sql).
They fix the later financial cut and preserve the original inference cut, use READ ONLY transactions with
12–15-second statement timeouts, and emit no raw account identifiers, credentials or provider payloads.
This is a historical evidence read, not a new system assessment.

Source contracts inspected at c217/4c07: `src/db/broker-fees.ts`, migrations 0063 and 0105,
`src/blocked-generation-recovery.ts`, `src/composition/capital-activation.ts`,
`src/execution/configuration.ts` and migration 0181. Their deployed source was 87a8d928 as recorded above.
