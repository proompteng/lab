# Bayn v2 Concurrent Three-Engine Intraday Alpha

## Strategy and evidence scope

`bayn.intraday-alpha-policy.v2` / `bayn.intraday-alpha.behavior.v3` combines three engines on disjoint equity and ETF sleeves. Revision `781245143760bf6bc78dbd8c4afe0770f254d0f4` introduced this policy, concurrent execution, and sandbox risk policy `bayn.execution-risk-policy.v6` with a $180,000 account gross cap. These are configured constraints; the offline scenario does not prove the final account-risk path.

The [historical v1 guide](intraday-alpha-v1-historical-evidence.md) and its original [evidence](evidence/2026-11-26-alpha-replay/results.json) remain tied to the two-phase policy and its exact source hash. Those results do not validate v2. The v2 bar scenario below is **UNQUALIFIED** research evidence and is not realized trading P&L.

| Engine               | Implemented behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Morning ORB          | Eighteen single-name equities, excluding QQQ/SMH; 30-minute opening range with opening-candle direction, VWAP and SPY confirmation. One committed attempt per session, including unfilled orders. Stop = clamp(round(0.35 × ATR14 in bp), 50, 300); target = 2 × stop; weight = min(0.35, 50 / stop). Maximum hold 60 minutes from first fill, also capped by the absolute 11:28 ET flatten deadline.                                                                    |
| Midday relative VWAP | The same eighteen equities; negative relative-VWAP laggards long and positive leaders short. Up to two pairs at 18% per leg, with a single-leg fallback. 500 bp stop / 800 bp target; flatten begins 15:55 ET, or five minutes before an early regular close. Planned neutrality does not ensure filled neutrality.                                                                                                                                                      |
| Noise-area momentum  | QQQ and SMH; completed top-of-hour checkpoints at elapsed minutes 31, 91, 151, 211, 271 and 331. Prior-session average swings define bands around max/min of today's open and prior close, with VWAP confirmation. Inverse-ATR weights within a 50% gross sleeve budget, 15–32% per leg, one committed attempt per ETF/session. Stop = clamp(round(1.5 × ATR14 in bp), 150, 600), target 1500 bp; flatten begins 15:58 ET, or two minutes before an early regular close. |

The trailing-baseline builder uses up to fourteen strictly prior sessions and requires at least five valid sessions per symbol. Live loading can supplement sparse intraday series with a coherent adjusted-daily snapshot. The supplied bar scenario does not include that supplement.

Research motivates these hypotheses. The opening-range and noise-area references are [Zarattini, Barbon and Aziz working papers](https://www.sfi.ch/en/publications/n-24-98-a-profitable-day-trading-strategy-for-the-u.s.-equity-market) ([noise-area paper](https://www.industry.sfi.ch/de/publications/n-24-97-beat-the-market-an-effective-intraday-momentum-strategy-for-s-p500-etf-spy)). Their instruments, periods and rules differ from Bayn's implementation. Broader volatility-management and reversal research does not establish Bayn's particular ATR multipliers or relative-VWAP recipe. No retained 703-session return series, data receipt or model-selection chronology substantiates the earlier v2 guide's “703 OOS sessions / 6 positive half-years” claim, so it is not an acceptance criterion.

## Corrected v2 bar scenario: August 25–November 25, 2026

The verifier calls production baseline, signal, funded-plan and target-planner functions. It uses fixed $100,000 equity and a **hypothetical 4× buying-power account**, less occupied entry notional, with whole shares and a hypothetical 0.21 bp sell-side charge. This is not a broker margin, collateral or fee reconciliation.

The two separately hashed exports contain the original 420,137 symbol-minute rows and an additional 55,999 warmup rows for August 4–24. Their provider calendars contain 81 dates; the explicit evaluation window contains all 66 August 25–November 25 sessions. The [combined calendar](evidence/2026-11-26-alpha-v2-replay/calendar.json), [warmup receipt](evidence/2026-11-26-alpha-v2-replay/warmup-receipt.json), [original input receipt](evidence/2026-11-26-alpha-replay/source-receipt.json) and [results](evidence/2026-11-26-alpha-v2-replay/results.json) retain provenance.

Warmup coverage is incomplete: ten symbols have fifteen supplied sessions; QQQ, SMH, SPY, AAPL, AMZN and IWM appear only on August 24 afternoon, with 118–143 minutes each. Consequently, QQQ/SMH lack usable supplied baselines for the first five evaluation dates, and 63 of 66 evaluation dates lack a baseline for at least one candidate. Every evaluation date has a valid baseline for some symbols. The scenario follows the production selector's eligibility rules with these partial supplied baselines; it is not a reproduction of the live adjusted-daily supplement. Missing symbols are listed per date.

**The complete 66-session economic outcome is unavailable in all three cost scenarios.** A required current mark for a held position is missing on November 17. The replay stops further planning at that first unknown decision because it could change quotas, occupancy and account headroom. It preserves the already supported trade and its eventual exit. All 66 calendar sessions remain in the report: 65 have complete modeled observations, and one is unavailable. Whole-window net, phase net, Sharpe, drawdown and chronological slices are `null`.

The following are **supported closed-leg subtotals**, covering the observed path before any gap. They are not complete session or strategy profit and do not bound the missing outcome.

| Round-trip slippage | Morning closed legs / subtotal | Midday closed legs / subtotal | Noise closed legs / subtotal | All supported closed-leg subtotal | Complete 66-session net |
| ------------------- | ------------------------------ | ----------------------------- | ---------------------------- | --------------------------------- | ----------------------- |
| 2 bp                | 52 / +$695                     | 196 / +$9,623                 | 52 / −$46                    | +$10,271                          | Unavailable             |
| 5 bp                | 51 / +$436                     | 188 / +$6,806                 | 50 / −$170                   | +$7,072                           | Unavailable             |
| 10 bp               | 45 / −$1,629                   | 168 / +$5,776                 | 48 / −$436                   | +$3,711                           | Unavailable             |

Within these supported trades, noise-engine subtotals are negative in all three scenarios and morning ORB is negative at 10 bp. Incomplete decision observations and candidate baselines prevent a full-policy economic conclusion. These results do not justify selecting new parameters from this cohort.

The supported paths contain 69 / 67 / 63 committed entry attempts while another sleeve is held, at most six concurrent legs, and at most approximately $119,106 gross entry notional. They have zero target-planner blocks and zero unresolved modeled exits. Each scenario stops new planning at the November 17 co-held-mark gap; its previously supported closed-trade subtotal remains −$81.35 / −$90.78 / −$106.50. This diagnostic does not prove broker reservations, protection or final risk passed. The supplied corpus has no missing benchmark at the actually visited active checkpoints; lower daily SPY bar counts alone do not establish a missing required decision.

Each scenario contains four bars with a triggered stop-limit lacking an executable price proxy; the stop remains working. There are no both-touch bars in this corpus; deterministic tests cover the conservative stop-first convention.

The supported midday baskets remain materially directional after independent fills:

| Slippage | All four intended legs filled / closed subtotal | Partial selected baskets / closed subtotal | One-sided filled baskets / closed subtotal |
| -------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 2 bp     | 25 / +$6,199                                    | 36 / +$3,358                               | 13 / +$2,736                               |
| 5 bp     | 18 / +$2,843                                    | 43 / +$3,935                               | 14 / +$2,559                               |
| 10 bp    | 8 / +$1,233                                     | 53 / +$4,760                               | 18 / +$2,321                               |

These groups cover only supported committed baskets, overlap or omit other structures, and must not be added together or treated as whole-cohort profit. One-sided baskets include the single-leg fallback; fully filled two-leg pairs are reported separately from four-leg completeness in the underlying selected-leg records. Two supported midday attempts are completely unfilled at 10 bp and retain true zero basket outcomes. Mean absolute residual entry exposure in partial baskets is about $20,400–$20,500, reaching approximately $36,000.

Concentration is also fragile within the supported closed-trade subtotals: the five largest daily subtotals account for 79.38% / 111.87% / 207.75% at 2 / 5 / 10 bp; the other 61 retained daily subtotals sum to +$2,117.93 / −$839.14 / −$3,998.13. November 17 remains a partial subtotal in this calculation. These are descriptions of the supported subset, not complete daily returns, selective exclusions, independent holdouts or profitability gates. Full-window concentration and chronological performance are unavailable.

For comparison, the unmodified `7812451437` verifier on these exact two exports reports about +$12,004 / +$8,412 / +$4,146, retained in the [baseline transcript](evidence/2026-11-26-alpha-v2-replay/baseline.txt). Its “OOS” and “PASSED” text is historical program output, not an endorsed qualification. Correcting simulation rules can move results in either direction.

## Replay guarantees and limitations

Input revisions must be explicitly selected upstream; the parser rejects conflicting revisions and retains file hashes. Calendar sessions and early closes come from the provider envelope. The historical selector is deterministic but uses revised archival bars: event-time ordering does not establish original consumer arrival causality.

Committed decisions consume morning and ETF session quotas even if unfilled. The simulator waits until an entry attempt's modeled working window resolves before planning again; future fill outcomes cannot supply inventory or headroom to an earlier decision. Occupancy is disjoint by symbol. It models timed exits at the first whole-minute open strictly after the deadline, including 12:55 midday and 12:58 noise deadlines on a 13:00 regular close. V2's absolute morning deadline also applies to delayed fills.

A completely missing supplied baseline makes the outcome unavailable. At each visited active decision, the production extractor must supply a valid completed-SPY/VWAP result; an opening-only or stale benchmark is unavailable, while a finite zero signal is valid. Pending-attempt and outside-window skips do not invent required observations. A missing required co-held current mark also makes the path unavailable. After the first unavailable decision, new planning stops while already supported positions and exits remain inspectable. Baseline and benchmark availability, required checkpoint counts, missing checkpoint phase/timestamps and co-held-mark counts are reported separately. Missing exit prices preserve unresolved filled positions. Any unavailable required observation or unresolved exit suppresses whole-window net, phase net, Sharpe, drawdown and chronological slices; supported closed-leg subtotals remain separately named. An explicit `--evaluation-start` selects the evaluation window while preceding supplied dates remain baseline history. The tool retains all calendar dates and bar counts without arbitrary minimum-coverage thresholds.

The price model assumes synthetic quotes, universal short eligibility, full leg quantity at an eligible bar-price proxy, a one-minute entry working window, and fixed slippage. Historical executable quotes, eligibility and original arrival receipts are not supplied to this scenario. The working window does not reproduce a native ten-second quote/entry eligibility deadline. Capacity, queue priority, impact, borrow, funding and operating expense remain unmeasured. Concurrent account equity is fixed, not a full marked-to-market margin ledger. Ingestion, pending broker orders, reservations, authority, final risk, protection lifecycle, recovery and actual settlement are not exercised. SPY-excess metrics are omitted because the scenario does not establish execution-aligned benchmark valuation.

Reproduce with the source-verified eight-column TSV exports:

```sh
bun services/bayn/tools/verify-intraday-alpha-replay.ts \
  --calendar docs/bayn/evidence/2026-11-26-alpha-v2-replay/calendar.json \
  --evaluation-start 2026-08-25 \
  /path/to/warmup.tsv /path/to/bars.tsv > /path/to/v2-scenario.json
```

The tool emits `bayn.intraday-alpha-bar-scenario.v2`, the exact policy hash and `UNQUALIFIED`. Numerical performance is not an exit-code acceptance gate.

## Prospective evaluation and cutover

The [native alpha performance report](native-alpha-performance.md) links retained engine decisions and selected baskets
to actual execution and completed accounting episodes. Its explicit cost and ownership gaps retain the distinction
between supported gross results and fully costed prospective evidence.

Evaluate new sessions under the unchanged policy identity before claiming an executable edge or expanding capital. Report realized morning, midday and noise-engine net separately, including actual broker fees and any funding/borrow charges. Require canonical accounting coverage, settled inventory and valid reconciliation before labeling a session economically complete. Retain unavailable and unresolved outcomes.

Record committed attempts versus fills, sleeve overlaps, complete/partial/fallback baskets, signed and gross notional through the holding period, and the account's actual margin/reservation/protection state. Preserve contemporaneous IEX arrival, baseline, eligibility, decision and broker order/fill evidence. Freeze evaluation rules before observing a new cohort; do not retune on these sessions and call later slices holdout validation.

The v2 cutover uses migration `0222_intraday_alpha_v2_admission.ts` and settled-v1 migration `0223_intraday_alpha_v1_paper_settlement.ts`. The latter requires flat inventory, terminal execution, complete accounting and fresh reconciliation before restricting v1. Deployment follows immutable CI images, Kargo `bayn` promotion and Argo CD synchronization. An account-bound PAPER activation request must bind the exact v2 source revision, image, policy and risk identity. A replay result does not provide activation authority.

## Wave 1D L1 replay and post-session audit

The [frozen IEX L1 spread run](evidence/2026-11-27-v2-l1-spread-baseline/README.md) adds an optional
`--quotes <minute_l1.tsv>` scenario. Its `l1` result is separate from the existing `results` array of
2/5/10 bp scenarios. The TSV must have
`symbol, minute_utc, quote_count, first_bid, first_ask, last_bid, last_ask, median_spread_bps, p75_spread_bps`
columns, tab-separated. `diagnostics` describes supported closed legs, including reselected leave-one-symbol-out
paths and the bounded co-held-mark sensitivity. No diagnostic changes the strict completeness gate.

For multi-year runs, supply the provider calendar spanning the inputs and set `--evaluation-start` and
`--evaluation-end` to the desired inclusive session dates. Earlier files remain warmup history. For raw
as-traded bars crossing a verified split, pass `--splits <file.json>` with rows of the form
`{"symbol":"XYZ","effectiveDate":"YYYY-MM-DD","newShares":10,"oldShares":1}`. Historical baseline prices
(including checkpoint closes) are restated into the evaluated session's share units only for splits effective
by that session. Prices, volume, quotes, and executed quantities for that session stay as traded. Supply
only independently verified splits for the raw bars; do not apply a split twice to already adjusted data.

Run the read-only PostgreSQL audit for the configured v2 PAPER account after the provider's regular close.
For the November 27 early close (13:00 ET / 10:00 PT), use:

```sh
# Use the existing BAYN_POSTGRES_URL credential for the approved read-only Bayn target.
bun services/bayn/tools/audit-intraday-alpha-session.ts \
  --session 2026-11-27 --account <account-id> --regular-close 13:00
```

The report uses the New York calendar date, a repeatable-read snapshot, verified v2 decision and entry intent
identities, and canonical fills, accounting receipts, protection orders, cancel receipts and release proofs.
It reports per-engine realized gross and net **after direct fill fees** when the attribution and post-close
reconciliation are complete, and separately labels supported subtotals. The audit shows entry-fill slippage
against both the intended planner reference and exact signal bar close, Midday filled vs fully filled legs,
and the final signed entry notional. Session-dated posted equity fees are reported at account level and are
not prorated to engines: their canonical activities do not identify the owning fill or strategy. Rerun after
late fee postings; an empty fee set does not prove zero or final fees. Flatness requires both canonical
inventory and a post-close exact reconciliation with a fresh, bound broker position snapshot, no working
orders and no currently nonterminal intents created before the end of the selected date. The report is operational evidence, not a capital, deployment, or profitability gate.
