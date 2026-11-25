# Bayn Two-Phase Intraday Alpha (`bayn.intraday-alpha-policy.v1`) Cutover Guide

## 1. Overview & Motivation

`bayn.intraday-alpha-policy.v1` (`behavior = bayn.intraday-alpha.behavior.v2`) replaces the negative-expectancy 30-minute visual chasing protocol (`v40–v44`) with a peer-reviewed, strictly causal two-phase intraday equity alpha architecture operating on 20 liquid real-time equities from `torghut-core-equity-v3` (all 21 non-benchmark names excluding thin `CRDO`, benchmarked against `SPY` `CompletedBars`):

1. **Phase 2 — Morning Zarattini-Barbon-Aziz Opening-Candle-Direction `30m` ORB (`10:00–10:50 ET`):**
   - Anchored strictly to regular US equity trading hours (`09:30–16:00 America/New_York` from `providerSessions[].regularOpenAt/regularCloseAt`), eliminating pre-market `08:00 ET` session-envelope clock drift.
   - `1` concurrent leg at `20%` equity weight (`maxTradesPerSession = 2`, one entry per symbol per morning, `minimumOpeningRangeBars = 27`, `minimumRecent15MinBars = 13`).
   - Enforces the Zarattini, Aziz & Barbon (2024) opening-candle direction rule: Long breakouts require a bullish 30m opening range (`orClose > orOpen`) with `close > orHigh`, `close > VWAP`, and `SPY > SPY_VWAP`; Short breakdowns require a bearish 30m opening range (`orClose < orOpen`) with `close < orLow`, `close < VWAP`, and `SPY < SPY_VWAP`.
   - `100 bp` protective stop / `200 bp` profit target (`1:2` native Alpaca `BRACKET`/`OCO`/`STOP_LIMIT` with single-sided IEX stop guard), `60m` hold capped before `11:28 ET` (`hardExitMinuteFromOpen = 118`) so inventory is flat before Phase 1.

2. **Phase 1 — Midday-to-Close Bogousslavsky Dollar-Neutral Relative-VWAP Reversion (`11:30–12:00 ET -> 15:55 EOD`):**
   - Computes gap-resilient session VWAP directly from full-session RTH 1m bars (`09:30 ET` through completed window end, avoiding Flink's single-minute `GAP` resets).
   - Requires `minimumSessionBars >= 90` and `minimumRecent15MinBars >= 13` (strictly causal recent-tape liquidity filter).
   - Ranks cross-sectional `rel_VWAP_vs_SPY = (close/vwap - 1) - (spyClose/spyVwap - 1)` and selects `2` Long laggards + `2` Short leaders at `18%` weight per leg (`36%` Long + `54%` Short `150%`-collateral = `90%` max buying power — fits both `1×` cash-only and `2×` margin accounts with `0` `InsufficientBuyingPower` blocks). Falls back to a single `20%` extreme Long if borrow eligibility blocks all shorts.
   - `500 bp` catastrophe protective stop / `800 bp` profit target held until `15:55 ET` EOD flatten (`flattenMinuteFromOpen = 385`), allowing afternoon institutional rebalancing reversion to play out without noise stop-outs.
   - Uses `jev-1.14.0` as a fast single-stage numerical `catalyst_dislocation_veto` (`>= 0.85` threshold) across top candidates; vetoed names fall through to the next ranked candidate and provider outages fail open (`status: UNAVAILABLE`).

3. **Completed-Bar-Close Execution Pricing (`±10 bps` Limit):**
   - Single-exchange free IEX quotes exhibit `50–400+ bps` spreads and thin top-of-book `bidSize` on high-dispersion equities (`COHR`, `LITE`, `MRVL`, `SNDK`, `WDC`, `AMD`, `MU`), whereas IEX 1m bar closes track consolidated SIP within `0.5–3.6 bps` and Alpaca executes marketable limits against consolidated NBBO.
   - Entry pricing, funded exit plans, and risk sizing anchor to each selected symbol's completed 1m `latestBar.close ± 10 bps` (matching `maxAdverseSlippageBps = 10`) while retaining live quote freshness verification and two-sided stop/target crossing guards.

## 2. Production TypeScript 66-Session Offline Replay Verification (`2026-08-25` – `2026-11-25`)

The verifier (`services/bayn/tools/verify-intraday-alpha-replay.ts`) exercises the production signal, bar-close exit sizing, and `planTargets` on $100,000 of strict `1×` cash buying power with whole-share quantities and 0.21 bp sell-side fees. A simulated fill requires a post-decision bar open within the funded `±10 bp` limit after slippage.

| Round-trip slippage | Active sessions | Morning ORB30 trades & net P&L | Midday MR trades & net P&L | Combined net P&L | SPY-Excess (Long / Short) | Three chronological folds   | Max drawdown | Sharpe |
| ------------------- | --------------- | ------------------------------ | -------------------------- | ---------------- | ------------------------- | --------------------------- | ------------ | ------ |
| 2 bp                | 66/66           | 73, +$2,390                    | 209, +$9,620               | +$12,010         | +$5,783 / +$4,912         | +$922 / +$3,449 / +$7,640   | $1,259       | 4.48   |
| 5 bp                | 66/66           | 74, +$2,272                    | 200, +$7,021               | +$9,293          | +$4,782 / +$3,546         | +$675 / +$3,096 / +$5,523   | $1,575       | 3.68   |
| 10 bp               | 66/66           | 73, +$781                      | 180, +$5,886               | +$6,667          | +$2,899 / +$2,836         | −$142 / +$2,221 / +$4,589   | $2,102       | 2.68   |

Both Phase 2 (Morning) and Phase 1 (Midday), as well as Long and Short SPY-excess alpha, remain positive across all three slippage tiers (`2`, `5`, and `10 bp` RT) with `0` planner blocks.

## 3. Cutover & Live Activation Procedure

1. **PR 1 — Settle `v44` & Deploy `bayn.intraday-alpha-policy.v1` in `OBSERVE`:**
   - Migration `0221_v44_paper_settlement.ts` proves flat inventory, terminal cycles/intents, settled orders, complete accounting, and fresh exact reconciliation before restricting `bayn.jev.protocol.v44` to `OBSERVE` (`BLOCKED_STRATEGY_PROTOCOL_CUTOVER`).
   - Removes the retired `v44` `capital-activation-request` from `argocd/applications/bayn/alpaca-sealedsecret.yaml` and binds `nix/images/bayn.nix` and `argocd/applications/bayn/{deployment,execution-controller,execution-activation}.yaml` to the `bayn.intraday-alpha-policy.v1` (`behavior.v2`) hashes.
   - Merges to `main`, publishes the immutable image cohort via CI, promotes via Kargo `bayn` Stage (`kargo/bayn`), syncs via Argo CD, and verifies clean `OBSERVE / CLEAR` startup and exact reconciliation.
2. **PR 2 — Seal & Activate `PAPER / CLEAR` Mandate:**
   - Seals the account-bound `ResearchCapitalActivationRequest` referencing PR 1's exact published `sourceRevision`, `imageDigest`, and `bayn.intraday-alpha-policy.v1` strategy identity into `argocd/applications/bayn/alpaca-sealedsecret.yaml` with matching `proompteng.ai/bayn.mandate-identity` annotation.
   - Merges, promotes via Kargo/Argo CD, and verifies live `PAPER / CLEAR` authority running `bayn.intraday-alpha-policy.v1`.
