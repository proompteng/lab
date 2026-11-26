# Historical Bayn v1 Two-Phase Intraday Alpha Evidence

> Historical scope: this document and `evidence/2026-11-26-alpha-replay/` describe `bayn.intraday-alpha-policy.v1`, before the concurrent three-engine v2 cutover in `781245143760bf6bc78dbd8c4afe0770f254d0f4`. They do not validate v2. The [current guide](intraday-alpha-cutover.md) contains separate v2 evidence.

The exact audited v1 replay and matching imports are retained at [published revision e1d88c10729aa03a41ddfec37e935ac56ee41597](https://github.com/proompteng/lab/blob/e1d88c10729aa03a41ddfec37e935ac56ee41597/services/bayn/tools/verify-intraday-alpha-replay.ts). Its source SHA256 is `b8380d0218e5e816e486e19887c915cc0a9f77932f16fdb93b9e6ac3a8670791`. Reproduce the commands below in a checkout of that revision; the current verifier imports v2 policy and must not be used to relabel these v1 results. The original v1 JSON, calendar, source receipt and baseline transcript remain unchanged.

## 1. Overview & Motivation

`bayn.intraday-alpha-policy.v1` (`behavior = bayn.intraday-alpha.behavior.v2`) replaces the active Jev `v44` entry policy with two deterministic intraday signals operating on 20 equities from `torghut-core-equity-v3` (all 21 non-benchmark names excluding `CRDO`, benchmarked against `SPY` `CompletedBars`). Historical Jev evidence remains retained. The new policy's prospective economics require its own observed sessions.

The opening-range signal is an adaptation motivated by [Zarattini, Barbon and Aziz's working paper](https://www.industry.sfi.ch/en/publications/n-24-98-a-profitable-day-trading-strategy-for-the-u.s.-equity-market). Their principal result uses five-minute opening ranges and a daily selection of Stocks in Play from a much larger universe. Bayn's fixed universe, thirty-minute range, risk levels and exits differ. The midday relative-VWAP rule is a Bayn research hypothesis; the general intraday-return findings in [Bogousslavsky's research](https://bogousslavsky.github.io/) do not validate this exact trading recipe.

1. **Morning opening-candle-direction `30m` ORB (`10:00–10:50 ET` signal-bar starts):**
   - Anchored strictly to regular US equity trading hours (`09:30–16:00 America/New_York` from `providerSessions[].regularOpenAt/regularCloseAt`), eliminating pre-market `08:00 ET` session-envelope clock drift.
   - `1` concurrent leg at `20%` equity weight (`maxTradesPerSession = 2`, one entry per symbol per morning, `minimumOpeningRangeBars = 27`, `minimumRecent15MinBars = 13`).
   - Long breakouts require a bullish 30m opening range (`orClose > orOpen`) with `close > orHigh`, `close > VWAP`, and `SPY > SPY_VWAP`; Short breakdowns require a bearish 30m opening range (`orClose < orOpen`) with `close < orLow`, `close < VWAP`, and `SPY < SPY_VWAP`.
   - `100 bp` protective stop / `200 bp` profit target, using native Alpaca `BRACKET`/`OCO`/`STOP_LIMIT` protection. The maximum holding duration is at most `60m` and is shortened at decision time toward `11:28 ET` (`hardExitMinuteFromOpen = 118`). Runtime starts that duration at the actual first fill, so delayed fills can extend beyond the intended morning boundary. A stop-limit order can remain unfilled after a price gap.
   - The durable session quota counts committed decisions containing intents, including attempts whose orders expire without fills. The offline scenario follows the same quota.

2. **Midday relative-VWAP reversion (`11:30–12:00 ET` signal-bar starts):**
   - Computes gap-resilient session VWAP directly from full-session RTH 1m bars (`09:30 ET` through completed window end, avoiding Flink's single-minute `GAP` resets).
   - Requires `minimumSessionBars >= 90` and `minimumRecent15MinBars >= 13` (strictly causal recent-tape liquidity filter).
   - Ranks cross-sectional `rel_VWAP_vs_SPY = (close/vwap - 1) - (spyClose/spyVwap - 1)` and selects `2` Long laggards + `2` Short leaders at `18%` weight per leg. The modeled buying-power requirement is `36%` Long plus `54%` Short collateral, or `90%` of equity. Actual account, reservation, risk and eligibility checks still apply. The signal can fall back to a single `20%` extreme leg when a pair is unavailable.
   - Planned allocations are dollar-neutral within whole-share rounding; independent limit orders can fill a subset and create residual directional exposure. Research reports complete, partial, both-sided and one-sided baskets separately.
   - `500 bp` catastrophe protective stop / `800 bp` profit target. Forced flattening begins at the earlier of minute `385` from regular open and five minutes before the provider's regular close. A 13:00 ET early close therefore starts flattening at 12:55 ET, including when the data calendar spans extended hours.
   - Runs deterministically (`catalystVeto.enabled = false`). Enabling live catalyst vetos in a future policy requires durable inference expense journaling first.

3. **Completed-Bar-Close Execution Pricing (`±10 bps` Limit):**
   - The policy uses completed-bar reference prices while retaining fresh IEX quotes for liveness and crossing guards. [Alpaca PAPER matches against NBBO](https://docs.alpaca.markets/us/docs/paper-trading), while paper-only market-data entitlement is IEX. A completed IEX close is a historical reference, not proof that a new order can fill at that price or quantity.
   - Entry pricing, funded exit plans, and risk sizing anchor to each selected symbol's completed 1m `latestBar.close ± 10 bps` (matching `maxAdverseSlippageBps = 10`) while retaining live quote freshness verification and two-sided stop/target crossing guards.

## 2. Retrospective 66-Session Bar Scenario (`2026-08-25` – `2026-11-25`)

The tool (`services/bayn/tools/verify-intraday-alpha-replay.ts`) exercises the production signal, funded-plan and target-planner functions on a fixed $100,000 allocation with `1×` buying power, whole shares and a hypothetical 0.21 bp sell-side fee. It reports `UNQUALIFIED` research results. It does not exercise source ingestion, actual quote arrival, authority, final risk, submission or recovery. Short eligibility and quotes are synthetic. Price proxies assume full leg quantity and omit capacity, queue priority, impact, borrow and operating costs.

The November 26 rerun used an explicitly filtered Alpaca IEX final-bar export. Its 420,137 symbol-minute rows include CRDO; the current policy accepts 399,233 rows for its 20 candidates plus SPY before the regular-hours filter. The export resolves 1,062 conflicting symbol-instants using the receipt's deterministic latest-ingest ordering. Consequently, this is an event-time study with revised archival bars, not proof of what an original consumer knew at a decision. The input SHA256 is `6c2753fc2dddae60554a501ef508ffa1568fb51af859b687b29b2dbb7efe4180`. See the [source receipt](evidence/2026-11-26-alpha-replay/source-receipt.json), [calendar](evidence/2026-11-26-alpha-replay/calendar.json) and [results](evidence/2026-11-26-alpha-replay/results.json).

The original tool at `d6316076f3668423dab04d6b65f3e95fd4da60fb` reproduces the previously reported $12,010 / $9,293 / $6,667 modeled results on this exact export. The corrected tool counts unfilled committed morning attempts against the production quota, starts duration at the modeled first fill, caps midday by the actual regular close, and uses a post-deadline price for timed exits. Missing exit prices retain unresolved positions and withhold whole-sample P&L, drawdown and Sharpe.

| Round-trip slippage | Trades (morning / midday) | Morning modeled net | Midday modeled net | Combined modeled net | Original tool | Descriptive Sharpe | Max drawdown |
| ------------------- | ------------------------- | ------------------- | ------------------ | -------------------- | ------------- | ------------------ | ------------ |
| 2 bp                | 65 / 208                  | +$2,284             | +$8,614            | +$10,898             | +$12,010      | 4.09               | $1,258       |
| 5 bp                | 65 / 199                  | +$1,959             | +$6,030            | +$7,989              | +$9,293       | 3.12               | $1,911       |
| 10 bp               | 59 / 179                  | −$396               | +$4,903            | +$4,507              | +$6,667       | 1.83               | $2,999       |

All 66 calendar sessions remain in the denominator. The corrected corpus has zero unresolved exits and zero planner blocks under the synthetic portfolio assumptions. Each slippage scenario encounters 77 bars where a triggered stop-limit lacks an executable price proxy; those orders remain working until a later eligible price or timed flatten. The sample contains zero bars touching both target and stop; regression tests cover the conservative stop-first convention for that ambiguity. Chronological slices are descriptive reuse of the same research cohort, not independent holdout validation.

Results are concentrated in a few days. At 2 / 5 / 10 bp, the five strongest sessions contribute 73.31% / 98.76% / 158.72% of aggregate modeled net; the remaining 61 sessions contribute +$2,908.65 / +$98.98 / −$2,646.91. At 10 bp, the three chronological slices contribute −$52.41 / +$1,611.44 / +$2,948.42. These are descriptive sensitivity calculations on all retained outcomes, not selective session exclusions or new acceptance gates. The report omits SPY-excess metrics because this bar scenario does not establish a benchmark valuation aligned to each modeled execution time.

The morning signal loses money in the 10 bp scenario. The midday result also depends materially on incomplete baskets:

| Round-trip slippage | Complete midday baskets / modeled net | Partial baskets / modeled net | One-sided baskets / modeled net | Mean absolute residual exposure in partial baskets |
| ------------------- | ------------------------------------- | ----------------------------- | ------------------------------- | -------------------------------------------------- |
| 2 bp                | 27 / +$5,504                          | 39 / +$3,110                  | 12 / +$2,257                    | $21,114                                            |
| 5 bp                | 19 / +$2,793                          | 47 / +$3,238                  | 13 / +$2,075                    | $20,929                                            |
| 10 bp               | 9 / +$367                             | 56 / +$4,536                  | 17 / +$1,780                    | $20,688                                            |

One-sided baskets are a subset of partial baskets, not an additional contribution. One midday attempt is entirely unfilled at 10 bp and retains a true zero outcome. Partial baskets reach about $36,000 absolute net exposure on $100,000 equity. These scenarios support investigating entry completion and realized exposure; they do not establish a dollar-neutral economic edge or justify choosing a policy from this same sample.

Reproduce with a provider-calendar envelope containing `query: { start, end }` and the native calendar `response` array, plus the eight TSV columns `symbol,eventAt,open,high,low,close,volume,vwap`:

```sh
bun services/bayn/tools/verify-intraday-alpha-replay.ts \
  --calendar docs/bayn/evidence/2026-11-26-alpha-replay/calendar.json \
  /path/to/bars.tsv > /path/to/scenario.json
```

The report hashes the inputs and calendar, rejects conflicting duplicate bar revisions, retains sessions with missing benchmark data, exposes unfilled and partial attempts, and emits explicit unresolved exits. Friday's 210-minute session is covered by deterministic regression fixtures; this historical corpus ends November 25 and contains no November 27 observations.

## 3. Prospective Evaluation

Before using these results to expand capital or claim an executable edge, evaluate new PAPER sessions under the unchanged policy identity. Report morning and midday realized net P&L separately; reconcile actual broker fees and any recorded funding or borrow charges, and identify unmeasured operating costs. Require canonical accounting coverage, settled inventory and valid reconciliation before treating a session as economically complete. Missing or unresolved outcomes must remain visible rather than becoming zero returns or disappearing from the denominator.

Record committed entry attempts, filled legs, complete and partial baskets, one-sided exposure, and signed/gross notional through the holding period. Compare the intended dollar-neutral basket with the exposure actually obtained. Retain contemporaneous IEX arrival receipts, decision inputs, eligibility and broker order/fill events so the next study can test execution and data availability. Freeze evaluation rules before observing that new cohort; do not adjust thresholds on these same 66 sessions and call the resulting slices a holdout. Neither the combined positive bar scenario nor its high activity rate establishes a profitable dollar-neutral strategy.

## 4. Historical v1 Cutover Procedure

1. **PR 1 — Settle `v44` & Deploy `bayn.intraday-alpha-policy.v1` in `OBSERVE`:**
   - Migration `0221_v44_paper_settlement.ts` proves flat inventory, terminal cycles/intents, settled orders, complete accounting, and fresh exact reconciliation before restricting `bayn.jev.protocol.v44` to `OBSERVE` (`BLOCKED_STRATEGY_PROTOCOL_CUTOVER`).
   - Removes the retired `v44` `capital-activation-request` from `argocd/applications/bayn/alpaca-sealedsecret.yaml` and binds `nix/images/bayn.nix` and `argocd/applications/bayn/{deployment,execution-controller,execution-activation}.yaml` to the `bayn.intraday-alpha-policy.v1` (`behavior.v2`) hashes.
   - Merges to `main`, publishes the immutable image cohort via CI, promotes via Kargo `bayn` Stage (`kargo/bayn`), syncs via Argo CD, and verifies clean `OBSERVE / CLEAR` startup and exact reconciliation.
2. **PR 2 — Seal & Activate `PAPER / CLEAR` Mandate:**
   - Seals the account-bound `ResearchCapitalActivationRequest` referencing PR 1's exact published `sourceRevision`, `imageDigest`, and `bayn.intraday-alpha-policy.v1` strategy identity into `argocd/applications/bayn/alpaca-sealedsecret.yaml` with matching `proompteng.ai/bayn.mandate-identity` annotation.
   - Merges, promotes via Kargo/Argo CD, and verifies live `PAPER / CLEAR` authority running `bayn.intraday-alpha-policy.v1`.
