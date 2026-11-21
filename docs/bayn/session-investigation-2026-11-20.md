# Bayn PAPER economics and entry recovery: November 16–20, 2026

Status: evidence for the active profitability and reliability investigation. This document records a bounded
historical cut; source, GitOps and fresh runtime evidence remain authoritative.

## Scope and provenance

Read-only evidence was collected on November 21, 2026, approximately 04:38–04:47 UTC. Financial rows cover
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
it is not a fresh independent reread of every native TigerBeetle transfer. The latest retained reconciliation is
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
terminates at 20:13:03.342. All six lack provider receipts and have positive non-dispatch cost evidence in the
latest quote set. They consume the next source window before the successor can use it. Repair ownership and the
original-cycle deadline boundary; retain the ten-second inference budget and every pricing and financial check.

The remaining completed receipts in these cycles are on time. Several valid pricing rejections must remain
rejections: a reached profit target or widened spread cannot become an authorized entry. The 20:38 completion-to-owner
delay is evidence for tracing resume/persistence latency, not proof that the rejected trade would have made money.

Across completed receipts, median / p95 elapsed request time improves from **1.758 / 4.467 seconds** on November 18
to **0.659 / 1.408 seconds** on November 20. This measures the receipt's started/completed interval, not complete
market-event-to-broker-acknowledgement latency. The realized losses rose while this component became faster.

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
3. Retain the economic baseline above through rollout. Verify deployed code and runtime behavior separately
   from prospective profitability. Additional throughput is useful only with a qualified economic comparison.
4. Obtain complete operating-cost evidence and register untouched prospective sessions, candidate identity,
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
