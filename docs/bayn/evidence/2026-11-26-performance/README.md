# Bayn PAPER performance evidence — 26 November 2026

## Finding

The latest completed session, **25 November**, lost **$131.32 gross** and **$145.80 after canonical broker fees**.
Including the retained list-rate inference estimate gives **-$146.098488372** before infrastructure, market-data,
research, and any other unallocated operating costs.

The 24–25 November v44 cohort remains **+$129.61 after canonical broker fees**, or **+$129.018912664 after known
inference estimates**, across 65 completed, flat-to-flat episodes. That small positive cohort does not establish
persistent profitability. Across the eight observed sessions from 16–25 November, the account lost **$1,286.42
after canonical broker fees**.

At the pre-release audit cutoff, deployed source was `d6316076f3668423dab04d6b65f3e95fd4da60fb`. Its
`bayn.intraday-alpha-policy.v1` authority became active at **2026-11-26T08:20:21.654766Z**.
At the 08:47 UTC read, it had **zero post-activation cycles**. The following realized results belong to the
previous v41/v43/v44 strategies, not the newly activated two-phase alpha strategy.

The subsequent main change `781245143760bf6bc78dbd8c4afe0770f254d0f4` introduces the three-engine v2
protocol and a separate activation cutover. This audit predates that release and supplies no realized
performance evidence for either alpha protocol. See the [current cutover guide](../../intraday-alpha-cutover.md)
for version-specific research and activation requirements.

## Retained lifetime account bridge

The recent November 16–25 cohort was selected to diagnose recent v41/v43/v44 behavior; it is not the beginning
of retained history. The full account has **3,041 canonical fills across 42 New York execution dates**, from
**2026-09-10T19:50:37.128231Z** through **2026-11-25T20:59:51.988404Z**. All 3,041 match one accounting
transaction and one retained posting receipt, with no quantity or price mismatch. All also retain an intent and
cycle association.

The **$100,000 starting cash/equity is observed**, both in the earliest account snapshot on
2026-07-30T06:49:48.171Z and immediately before the first fill on 2026-09-10T19:50:35.355Z.
The fixed closing snapshot at 2026-11-26T09:04:09.135Z has **$93,038.64 cash/equity**. Thus the retained account
lost **$6,961.36, or 6.96136% of its observed initial capital**, before separately billed inference, data,
infrastructure and research costs.

| Retained lifetime component | USD |
| --- | ---: |
| Observed initial cash/equity | 100,000.000000 |
| Realized gross trading P&L | -2,423.533819 |
| Cash-denominated broker fees | -2,363.920000 |
| Cost basis of coin-denominated broker fees | -2,173.980374 |
| Posted cash-settlement rounding credit | +0.074193 |
| **Calculated and observed ending cash/equity** | **93,038.640000** |
| **Unexplained difference** | **0.000000** |

Execution fees total **$4,537.900374**, comprising $2,167.99 of crypto cash fees, $195.93 of other broker
cash fees, and $2,173.980374 of coin fee expense. The gross-trading less execution-fee subtotal is
**-$6,961.434193**; the observed cash decline differs by the separately posted $0.074193 rounding credit.
All 340 retained settlement rows were posted. Transaction-level `fee_micros` is zero throughout, so summing
that field alone would incorrectly report zero fees.

The independent cash-flow expression also closes exactly:
**$100,000 - $4,597.514193 fill cash flow - $2,363.92 cash fee flow + $0.074193 rounding = $93,038.64**.
The $2,173.980374 coin cost is already embedded in the difference between fill cash flow and gross P&L;
subtracting it again from the cash-flow expression would double count it. The canonical
`broker_cash_fee_deltas` and `broker_inventory_debits` views reconcile provisional fee accruals with later
broker activities. In particular, the $2,167.97 raw cash accrual must not be added again to the settled
$2,363.92 cash-fee total.

### Historical assets and inventory

| Historical asset cohort | Fills | Realized gross USD | Cash fees USD | Coin fee basis USD | Net before rounding USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Crypto, October 14–23 UTC | 348 | -1,032.453819 | 2,167.990000 | 2,173.980374 | -5,374.424193 |
| Equities, September 10–November 25 UTC | 2,693 | -1,391.080000 | 195.930000 | 0.000000 | -1,587.010000 |
| **Total historical account** | **3,041** | **-2,423.533819** | **2,363.920000** | **2,173.980374** | **-6,961.434193** |

This separates the large historical crypto fee burden from the equity strategy now under investigation.
The lifetime numbers span many historical policies and cannot be assigned to today's two-phase alpha authority.

Fills alone leave apparent BTC/USD, ETH/USD and SOL/USD quantity and cost-basis residuals. These exactly equal
posted coin-fee inventory deductions; after those deductions, **all 15 symbols have zero quantity and
zero cost-basis residual**. The first and last selected position snapshots both have zero positions, and the
2026-11-26T09:04:14.174Z reconciliation is `EXACT` with zero discrepancies. This establishes a retained
account-level flat-to-flat bridge including fee adjustments; it does not manufacture fill-only closed crypto
episodes or supply per-episode fee allocation.

The execution-unit cutover archive contains 412 historical fill copies from September 10–October 13.
Every copy matches an existing canonical fill by event ID and source timestamp, and all 412 also match by
provider fill ID. Adding those archived rows would double count executions. The source selectors retain
all symbol gross totals and all 42 execution-date gross aggregates; fee economic dates are shown separately
because delayed broker fee postings do not justify synthetic daily net returns or drawdown estimates.

The [lifetime selector](lifetime.sql) and [captured lifetime results](lifetime-results.txt) reproduce both
cash bridges, fee classes, inventory adjustments, boundaries, receipt coverage and archive overlap.
They ran at 09:09:08 UTC against the verified standby, with a fixed 09:04:15 UTC economic/account cutoff
and approximately six seconds of replica lag. This is an audit of retained canonical records; individual
TigerBeetle transfers and independently billed operating expenses were not re-audited.

## Reconciled session economics

Execution dates use America/New_York. Fees below are posted broker economic-date debits. Inference estimates use
the latest retained quote per request and provider stage, selected before the fixed 08:40 UTC evidence cutoff.
They are not invoice reconciliations.

| Session | Protocol | Flat episodes | Wins / losses | Gross USD | Broker fees USD | After broker fees USD | Known inference estimate USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Nov 16 | v41 | 31 | 15 / 16 | -111.92 | 11.70 | -123.62 | 0.410036130 |
| Nov 17 | v41 | 15 | 11 / 4 | 40.23 | 5.82 | 34.41 | 0.306205536 |
| Nov 18 | v41 | 16 | 9 / 7 | -176.33 | 6.21 | -182.54 | 0.406171794 |
| Nov 19 | v41 | 47 | 16 / 31 | -590.70 | 17.56 | -608.26 | 0.330870876 |
| Nov 20 | v41 | 60 | 26 / 34 | -513.28 | 22.74 | -536.02 | 0.233999892 |
| Nov 23 | v43 | 0 | 0 / 0 | 0.00 | 0.00 | 0.00 | 0.075286512 |
| Nov 24 | v44 | 24 | 15 / 9 | 284.11 | 8.70 | 275.41 | 0.292598964 |
| Nov 25 | v44 | 41 | 21 / 20 | -131.32 | 14.48 | -145.80 | 0.298488372 |
| **Total** | **Mixed historical protocols** | **234** | | **-1,199.21** | **87.21** | **-1,286.42** | **2.353658076** |

November 16, 17, and 18 retain respectively 48, 274, and 37 inference stages with unknown usage. Their known-cost
figures are incomplete. November 23–25 have no such unknown stages in the retained expense cohort. Operating
expenses remain outside these figures.

The broker cash bridge independently matches the session aggregation:

- First selected cash/equity: **$94,325.06**, 2026-11-16T00:00:43.244Z.
- Last selected cash/equity: **$93,038.64**, 2026-11-26T08:39:52.119Z.
- Difference: **-$1,286.42 = -$1,199.21 gross trading - $87.21 canonical fees**, with zero residual.

All **1,178 selected fill rows** have one matching accounting transaction and one retained TigerBeetle posting
receipt. Quantity and price match exactly; event and provider fill IDs are unique. All 234 episode quantities
return to zero. This is a stored-receipt tie-out; the investigation did not independently reread every
TigerBeetle transfer record.

## Why 25 November lost money

The 41 episodes have a 51.22% win rate, but their **$891.49 winning gross P&L** is smaller than their
**$1,022.81 losing gross P&L**. The mean winner is $42.45, mean loser $51.14, and gross profit factor 0.872.
The realized payout distribution requires approximately 54.64% winners to break even before costs.

The shorts produced **-$264.11 across 31 episodes**, while longs produced **+$132.79 across 10 episodes**.
Largest negative symbol/direction cohorts were NFLX shorts (-$165.06), NVDA shorts (-$77.98), INTC longs
(-$62.33), and GOOGL shorts (-$54.93). These descriptive cohorts are too small to justify symbol bans.

The retained IEX SPY regular-session bar endpoints rose 0.5047% on November 24 and 1.9313% on November 25.
There are 390 retained SPY minutes for each date. The second day's short-side losses are consistent with
directional exposure during a rebound; session endpoints do not identify causality or establish factor-adjusted
alpha. The corresponding November 19/20 SPY returns were -2.9422%/-3.2065%, during the prior mostly-long losses.
All SPY values are retrospective exchange-only archive observations, not consolidated-market benchmarks.

### Exit attribution

Each closing fill is matched to its original entry cycle. Native order roles are verified from retained order
history; replacement OCO targets additionally match the original decision hash and protection levels.
Application closes use their exact ordered intent IDs. Gross P&L is assigned from each closing accounting row.

| November 25 closing role | Closing fills | Episodes touched | Attributed gross USD |
| --- | ---: | ---: | ---: |
| Native profit target | 47 | 18 | 654.641156 |
| Native stop | 36 | 16 | -862.450000 |
| Application profit target | 3 | 1 | 31.820000 |
| Protection released, profit requested | 4 | 3 | 74.983271 |
| Other protection released | 14 | 7 | -30.314427 |
| **Total** | **104** | **Counts overlap** | **-131.320000** |

No selected order had conflicting native role variants. The remaining 113 fills were entries.
`PROTECTION_RELEASED` records the application close path; it does not by itself prove a holding-time,
stop, or discretionary signal cause.

Every selected episode from November 16–25 stayed within its original modeled **gross** stop-loss budget.
This comparison does not allocate aggregate broker fees to episodes or prove future gap protection. Observed
losses are explained by the outcome mix, rather than a demonstrated breach of those original loss budgets.

### Original plan economics

The frozen gain/loss diagnostic uses estimated target net minus acquisition cost for longs, and estimated
target P&L for shorts; its denominator is the original estimated stop loss. It is not an estimated win probability.

| Original modeled gain / loss | Nov 24 episodes / gross USD | Nov 25 episodes / gross USD |
| --- | ---: | ---: |
| Below 0.25 | 11 / +155.70 | 26 / +112.72 |
| 0.25 to below 0.5 | 9 / -34.08 | 9 / -249.64 |
| 0.5 to below 1 | 3 / +218.67 | 5 / -147.12 |
| At least 1 | 1 / -56.18 | 1 / +152.72 |

The relationship is nonmonotonic. These observations do not support introducing another arbitrary reward/loss
cutoff. A change needs a fixed hypothesis, representative cost model, chronological evaluation and prospective
PAPER confirmation.

## Decision and execution funnel

| Metric | Nov 23 | Nov 24 | Nov 25 |
| --- | ---: | ---: | ---: |
| Completed cycles | 0 | 27 | 41 |
| No-trade cycles | 383 | 225 | 183 |
| Expired entry cycles | 148 | 144 | 144 |
| Expiries during regular hours | 9 | 7 | 2 |
| Captured candidate requests | 1,289 | 990 | 908 |
| Source-infeasible requests | 985 | 45 | 11 |
| No funded proposals | 294 | 749 | 637 |
| Ready with JEV response | 10 | 196 | 260 |
| Late retained inference receipts | 0 | 0 | 0 |
| Receipt elapsed median / p95 | 441 / 823 ms | 656 / 1,573 ms | 625 / 1,142 ms |

Cycle, candidate, order and episode counts have different grains. For example, November 24 has 27 completed
cycles but only 24 episodes with actual fills. November 25 has 54 stored risk decisions and all were approved.

Of November 25's 144 expired cycles, 87 began before regular hours and 55 afterward. They belong to the old
08:00–17:00 New York IEX data-window configuration and remain source/readiness diagnostics. They should not
be counted as 144 proven missed profitable trades.

The two regular-hour expiries began at 09:30:10.310 and 14:53:02.013 New York time. The first had zero inference
requests. The second retained three requests and all three receipts, with batch completion at 14:53:16.808
and terminal expiry at 14:54:02.136. These are timing/source diagnostics; the retained evidence does not prove
the foregone entries would have earned money. Provider inference elapsed time does not include every
market-arrival, owner-resume, submission and fill interval.

## Research input delivered to the replay investigation

The independent 66-session alpha replay input was rebuilt using existing read-only ClickHouse access:

- Event interval: August 25 through November 25 inclusive; ingestion strictly before 2026-11-26T08:40:00Z.
- Alpaca **IEX only**, final `bars` and `updatedBars`, 22 explicit symbols.
- 7,636,045 raw rows collapse to **420,137 symbol/exact-event instants**.
- 1,062 instants have conflicting OHLCV/VWAP content, containing 2,127 distinct content versions.
- Selection uses latest ingestion timestamp followed by deterministic source, universe and content ordering.
- Three retained universe contracts occur: `torghut-core-equity-v1`, `v2`, and `v3`.
- TSV SHA-256: `6c2753fc2dddae60554a501ef508ffa1568fb51af859b687b29b2dbb7efe4180`.
- 66 calendar dates come from retained Alpaca exchange-session rows, each with a single observed regular-hours pair.

An unrestricted raw-bar read also includes `delayed_sip`; it must not be silently combined with IEX.
The export contains retrospective final revisions, not original consumer-availability proof. It contains no
historical executable quotes, broker shortability snapshots, partial-fill sequence, or authority decisions.
The study therefore remains a model-based research comparison. The replay investigator owns its corrected
results and limitations separately.

## Decisions supported by this evidence

1. Measure each successor policy as a separate prospective cohort. Historical v41/v43/v44 results do not establish
   either alpha protocol's realized trade or basket economics.
2. Prioritize replay/runtime parity, session coverage, actual costs and portfolio-level partial-fill behavior before
   treating the attractive offline alpha study as executable expected profit.
3. Repair demonstrated feed/reconciliation availability defects while retaining the existing financial checks.
   Count recovered input windows and actual outcome changes separately from speculative opportunity value.
4. Measure direction, session phase, realized target/stop behavior, turnover and fee drag for each new policy
   cohort. The old historical losses motivate that evaluation; they do not calibrate the new strategy automatically.

## Reproduction and evidence

- [Protective-child stream compatibility and recovery evidence](broker-projection-replay.md).
- [Corrected alpha replay, execution assumptions and prospective evaluation](../../intraday-alpha-cutover.md).
- [Implementation and release validation](https://github.com/proompteng/lab/pull/16342).
- [Lifetime cash bridge SQL](lifetime.sql) and [captured lifetime results](lifetime-results.txt).
- [Performance SQL](performance.sql) and [captured performance results](performance-results.txt).
- [Funnel and symbol attribution SQL](funnel.sql) and [captured funnel results](funnel-results.txt).
- [Original plan economics SQL](plan-economics.sql) and [captured plan results](plan-results.txt).
- [Closing-fill attribution SQL](exit-attribution.sql) and [captured closing results](exit-results.txt).
- [SPY archive selector](spy-session-context.sql) and [captured SPY observations](spy-session-context.jsonl).

The PostgreSQL queries ran against `bayn-db-1`, verified as a standby. At the consolidated 08:47:35 UTC read,
its replay lag was approximately three seconds. SQL uses read-only transactions and bounded statement timeouts.
The financial cohort has one account; revalidate and add an explicit account predicate before reusing the
queries against a multi-account database. Individual account, broker order and credential identifiers are
excluded from these artifacts.
