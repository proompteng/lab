# Bayn Two-Phase Intraday Alpha (`bayn.intraday-alpha-policy.v1`) Cutover Guide

## 1. Overview & Motivation

`bayn.intraday-alpha-policy.v1` replaces the negative-expectancy 30-minute visual chasing protocol (`v40–v44`) with a two-phase strictly causal intraday equity alpha architecture operating on Bayn's existing 15 real-time WebSocket equities (`intradayUniverse` excluding `SPY`, benchmarked against `SPY` `CompletedBars`):

1. **Phase 2 — Bounded-Hold Morning `30m` Opening Range Breakout (`10:00–10:45 ET`):**
   - `1` concurrent leg at `20%` equity weight (`Long` or `Short` aligned with both symbol session VWAP and `SPY` session VWAP, `minimumOpeningRangeBars = 27`, `minimumRecent15MinBars = 13`, `maxTradesPerSession = 2`, one entry per symbol per morning).
   - `50 bp` protective stop / `100 bp` profit target (`1:2` native Alpaca `BRACKET`/`OCO`/`STOP_LIMIT` with `#16289` single-sided IEX stop guard).
   - Hard holding limit `min(45m, 118 - entryMinuteFromOpen)` guarantees flat inventory before `11:28 ET`, eliminating slot conflict with Phase 1.

2. **Phase 1 — Midday-to-Close Dollar-Neutral Relative-VWAP Overreaction Reversion (`11:30–12:00 ET -> 15:55 EOD`):**
   - Computes gap-resilient session VWAP directly from full-session observed 1m bars (`09:30 ET` through completed window end, avoiding Flink's single-minute `GAP` resets on `COHR`, `SNDK`, `LITE`, `CRDO`, `MRVL`).
   - Requires `minimumSessionBars >= 90` and `minimumRecent15MinBars >= 13` (strictly causal recent-tape liquidity filter) plus `maximumEntrySpreadBps = 25` (eliminating `v44`'s `5 bps` single-exchange IEX starvation).
   - Ranks cross-sectional `rel_VWAP_vs_SPY = (close/vwap - 1) - (spyClose/spyVwap - 1)` and selects `2` Long laggards + `2` Short leaders at `18%` weight per leg (`36%` Long + `54%` Short `150%`-collateral = `90%` max buying power — fits both `1×` cash-only and `2×` margin accounts with `0` `InsufficientBuyingPower` blocks). Falls back to a single `20%` extreme Long if borrow eligibility blocks all shorts.
   - `300 bp` protective stop / `400 bp` profit target held until `15:55 ET` EOD flatten.
   - Repurposes `jev-1.14.0` as a fast single-stage numerical `catalyst_dislocation_veto` (`>= 0.85` threshold) across top candidates; vetoed names cleanly fall through to the next ranked candidate, and provider outages fail open (`status: UNAVAILABLE`) so inference incidents never starve sessions.

## 2. Production TypeScript 65-Session Offline Replay Verification (`2026-08-25` – `2026-11-24`)

Executed via `bun run tools/verify-intraday-alpha-replay.ts` exercising the actual production TypeScript strategy (`extractIntradayAlphaCandidates`, `selectIntradayAlphaLegs`, `makeIntradayAlphaFundedExitPlan`) and production `target-planner` (`planTargets`) on `$100,000` `1×` cash-only capital with whole-share quantization, `0.21 bps` live Alpaca sell fees, and zero lookahead:

| Slippage Stress (RT) | Active Sessions | Total Trades (`ORB30` / `MR`) | Net P&L | SPY-Excess (`Long` / `Short`) | Monthly Folds (`F0` / `F1` / `F2`) | Max DD | Sharpe | `planTargets` Blocks |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`2.0 bp` RT** | **`65 / 65` (`100.0%`)** | `358` (`98` / `260`) | **`+$8,617`** | **`+$1,452` / `+$6,639`** | **`+$2,718` / `+$2,668` / `+$3,231`** | `$2,114` | **`+3.99`** | **`0`** |
| **`5.0 bp` RT** | **`65 / 65` (`100.0%`)** | `359` (`99` / `260`) | **`+$6,669`** | **`+$464` / `+$5,630`** | **`+$2,066` / `+$1,977` / `+$2,626`** | `$2,481` | **`+3.07`** | **`0`** |
| **`10.0 bp` RT** | **`65 / 65` (`100.0%`)** | `362` (`102` / `260`) | **`+$3,120`** | `-$1,510` / `+$4,033` | **`+$362` / `+$987` / `+$1,771`** | `$3,056` | **`+1.41`** | **`0`** |

Recent session spot checks (`2.0 bp` RT):
- `2026-11-20` (live `v41` lost `-$955`): `6` trades, **`+$551.80`**
- `2026-11-23` (Monday; live `v43` had `0` trades): **`6` trades**, `-$19.16` (zero starvation)
- `2026-11-24` (live `v44` made `+$275`): `6` trades, **`+$980.58`**

## 3. Infrastructure & Schema Compatibility

- **Zero Flink Changes:** Only Bayn's Kafka bootstrap seek for equity `bars` (`390m`) and in-memory bar projection (`391` minutes) were extended; `quotes` (`10s`), `trades` (`30m`), and Flink `PT30M` rolling features (`30m` suffix verified against `[max(rangeEnd - 30m, rangeStart), rangeEnd)`) remain unchanged.
- **Non-Destructive Admission Migration:** Migration `0220_intraday_alpha_admission.ts` widens `authority_generations` constraints, `intraday_candidate_observations_check`, `enforce_entry_policy_identity()`, and `enforce_strategy_protection_plan()` to admit `bayn.intraday-alpha-policy.v1` / `bayn.intraday-alpha-target.v1` alongside running `bayn.jev.protocol.v44` without touching live `v44` authority or retained `v28–v44` evidence.
- **Multi-Position Portfolio & Protection Support:** `JevPortfolioSchema`, `position-protection-interpreter`, `jev-position-postgres`, `shadow-decision-contract`, and `buildClosingExecutionCycleDecisionWithSource` support `1..4` mixed Long+Short legs, independent per-leg native `BRACKET`/`OCO`/`STOP_LIMIT` arming, partial early leg exits, and atomic multi-leg EOD flattening.

## 4. Safe Live Cutover Procedure (When Authorized)

1. **Merge & Promote Image via Kargo:** Merge reviewed PR to `main`, wait for immutable image publication, Freight creation, exact automatic Stage promotion (`kargo/<stage>`), and Argo sync. `0220_intraday_alpha_admission.ts` applies cleanly while `v44` continues running undisturbed.
2. **Observe/Settle `v44` (Flat Inventory & Exact Reconciliation):** After market close or when flat with zero working intents/orders, transition authority to `OBSERVE` and confirm exact reconciliation.
3. **Activate `bayn.intraday-alpha-policy.v1` Mandate:** Rotate the paper execution mandate to `intradayAlphaStrategyIdentity(makeIntradayAlphaPolicy(defaultJevProtocolDocument))` under `PAPER / CLEAR`, verify startup protocol hash and first regular-session `bayn.intraday-alpha-observation.v1` + `bayn.intraday-alpha-target.v1` persistence.
