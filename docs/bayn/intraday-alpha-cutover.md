# Bayn Two-Phase Intraday Alpha (`bayn.intraday-alpha-policy.v1`) Cutover Guide

## 1. Overview & Motivation

`bayn.intraday-alpha-policy.v1` replaces the negative-expectancy 30-minute visual chasing protocol (`v40–v44`) with a two-phase strictly causal intraday equity alpha architecture operating on Bayn's existing 15 real-time WebSocket equities (`intradayUniverse` excluding `SPY`, benchmarked against `SPY` `CompletedBars`):

1. **Phase 2 — Bounded-Hold Morning `30m` Opening Range Breakout (`10:00–10:45 ET`):**
   - `1` concurrent leg at `20%` equity weight (`Long` or `Short` aligned with both symbol session VWAP and `SPY` session VWAP, `minimumOpeningRangeBars = 27`, `minimumRecent15MinBars = 13`, `maxTradesPerSession = 2`, one entry per symbol per morning).
   - `50 bp` protective stop / `100 bp` profit target (`1:2` native Alpaca `BRACKET`/`OCO`/`STOP_LIMIT` with `#16289` single-sided IEX stop guard).
   - The software close becomes due after `min(45m, 118 - entryMinuteFromOpen)` to target flat inventory before `11:28 ET`.

2. **Phase 1 — Midday-to-Close Dollar-Neutral Relative-VWAP Overreaction Reversion (`11:30–12:00 ET -> 15:55 EOD`):**
   - Computes gap-resilient session VWAP directly from full-session observed 1m bars (`09:30 ET` through completed window end, avoiding Flink's single-minute `GAP` resets on `COHR`, `SNDK`, `LITE`, `CRDO`, `MRVL`).
   - Requires `minimumSessionBars >= 90` and `minimumRecent15MinBars >= 13` (strictly causal recent-tape liquidity filter) plus `maximumEntrySpreadBps = 25` (eliminating `v44`'s `5 bps` single-exchange IEX starvation).
   - Ranks cross-sectional `rel_VWAP_vs_SPY = (close/vwap - 1) - (spyClose/spyVwap - 1)` and selects `2` Long laggards + `2` Short leaders at `18%` weight per leg (`36%` Long + `54%` Short `150%`-collateral = `90%` max buying power — fits both `1×` cash-only and `2×` margin accounts with `0` `InsufficientBuyingPower` blocks). Checks executable long and short notionals after applying liquidity caps, allowing whole-share rounding. Falls back to a single `20%` extreme Long if borrow eligibility blocks all shorts.
   - `300 bp` protective stop / `400 bp` profit target held until `15:55 ET` EOD flatten.
   - Repurposes `jev-1.14.0` as a fast single-stage numerical `catalyst_dislocation_veto` (`>= 0.85` threshold) across top candidates; vetoed names cleanly fall through to the next ranked candidate, and provider outages fail open (`status: UNAVAILABLE`) so inference incidents never starve sessions.

## 2. Production TypeScript 65-Session Offline Replay Verification (`2026-08-25` – `2026-11-24`)

The verifier exercises the production signal, exit sizing, and target planner on $100,000 of cash buying power with
whole-share quantities and 0.21 bp sell-side fees. A simulated fill requires a bar open after the decision, before the
modeled 60-second order cutoff, at a price within the funded limit after entry slippage. A stop-limit order that
gaps through its limit stays pending until an executable price returns or the scheduled close takes over.
The model uses minute bars and synthetic quotes and short eligibility. Live fill probability and broker queue
priority are outside its scope.

| Round-trip slippage | Active sessions | Morning trades and net P&L | Midday trades and net P&L | Combined net P&L | Three chronological folds   | Max drawdown | Sharpe |
| ------------------- | --------------- | -------------------------- | ------------------------- | ---------------- | --------------------------- | ------------ | ------ |
| 2 bp                | 65/65           | 98, +$215                  | 206, +$6,590              | +$6,804          | +$1,602 / +$2,232 / +$2,971 | $2,458       | 3.18   |
| 5 bp                | 65/65           | 99, −$380                  | 206, +$5,999              | +$5,619          | +$1,622 / +$1,869 / +$2,128 | $2,613       | 2.65   |
| 10 bp               | 65/65           | 103, −$1,076               | 205, +$4,233              | +$3,158          | +$417 / +$1,148 / +$1,593   | $3,097       | 1.47   |

The combined strategy passed the offline activity and chronological profitability gate with zero planner blocks.
The morning phase lost money in the 5 and 10 bp runs.

## 3. Infrastructure & Schema Compatibility

- **Zero Flink Changes:** Only Bayn's Kafka bootstrap seek for equity `bars` (`390m`) and in-memory bar projection (`391` minutes) were extended; `quotes` (`10s`), `trades` (`30m`), and Flink `PT30M` rolling features (`30m` suffix verified against `[max(rangeEnd - 30m, rangeStart), rangeEnd)`) remain unchanged.
- **Non-Destructive Admission Migration:** Migration `0220_intraday_alpha_admission.ts` widens `authority_generations` constraints, `intraday_candidate_observations_check`, `enforce_entry_policy_identity()`, and `enforce_strategy_protection_plan()` to admit `bayn.intraday-alpha-policy.v1` / `bayn.intraday-alpha-target.v1` alongside running `bayn.jev.protocol.v44` without touching live `v44` authority or retained `v28–v44` evidence.
- **Multi-position protection.** The midday basket uses independent native `BRACKET`, `OCO`, or `STOP_LIMIT` orders for
  early fills. Bayn reconciles those fills and maintains protection for the other legs. Its cycle-wide close owns
  the remaining basket at end of day. The single-leg morning strategy also uses the existing timed software exit.

## 4. Safe Live Cutover Procedure (When Authorized)

1. **Merge & Promote Image via Kargo:** Merge reviewed PR to `main`, wait for immutable image publication, Freight creation, exact automatic Stage promotion (`kargo/<stage>`), and Argo sync. `0220_intraday_alpha_admission.ts` applies cleanly while `v44` continues running undisturbed.
2. **Observe/Settle `v44` (Flat Inventory & Exact Reconciliation):** After market close or when flat with zero working intents/orders, transition authority to `OBSERVE` and confirm exact reconciliation.
3. **Activate `bayn.intraday-alpha-policy.v1` Mandate:** Rotate the paper execution mandate to `intradayAlphaStrategyIdentity(makeIntradayAlphaPolicy(defaultJevProtocolDocument))` under `PAPER / CLEAR`, verify startup protocol hash and first regular-session `bayn.intraday-alpha-observation.v1` + `bayn.intraday-alpha-target.v1` persistence.
