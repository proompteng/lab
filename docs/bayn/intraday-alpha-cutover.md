# Bayn Three-Engine Concurrent Multi-Sleeve Intraday Alpha (`bayn.intraday-alpha-policy.v2`) Cutover Guide

## 1. Overview & Motivation

`bayn.intraday-alpha-policy.v2` (`behavior = bayn.intraday-alpha.behavior.v3`, sandbox risk policy `bayn.execution-risk-policy.v6` with `$180k` gross cap) upgrades Bayn from single-sleeve sequential execution to **concurrent disjoint-symbol multi-sleeve execution**, combining three peer-reviewed, strictly causal intraday equity alpha engines operating on 20 liquid equities from `torghut-core-equity-v3` (benchmarked against `SPY` `CompletedBars`) with a strictly causal 14-session ClickHouse trailing baseline (`signal.intraday_bars_1m_v2` with `signal.adjusted_daily_bars_v2` supplement, strictly `< sessionDate`):

1. **Engine 1 — Morning ATR-Scaled `30m` ORB (`10:00–10:50 ET`, 18 single-name equities excluding `QQQ`/`SMH`):**
   - Zarattini, Barbon & Aziz (2024) opening-candle direction rule + Moreira & Muir (2017) volatility-adaptive stops and inverse-ATR sizing.
   - `stopBps = clamp(round(0.35 × ATR14_bps), 50, 300)`, `targetBps = 2 × stopBps`, `weight = min(0.35, 50 / stopBps)`, `1` concurrent leg, `maxTradesPerSession = 1` (eliminates choppy-morning stop-out re-entry churn), `60m` hold capped before `11:28 ET` (`hardExitMinuteFromOpen = 118`).
   - Preserves minute-30 breakout capture on minute 31 if Engine 3 claimed the `10:00` top-of-hour checkpoint on `QQQ`/`SMH`.

2. **Engine 2 — Midday Dollar-Neutral Relative-VWAP Reversion (`11:30–12:00 ET -> 15:55 ET`, same 18 single-name equities):**
   - Bogousslavsky (2016/2021) / Nagel (2012) cross-sectional reversion of `vwapDev_i - vwapDev_SPY`.
   - Sign-gated (`long < 0`, `short > 0`) `2L + 2S` equal `18%` legs (`72%` gross), wide `500 bp` stop / `800 bp` target, native broker-managed exits, flatten `15:55 ET` (`flattenMinuteFromOpen = 385`).

3. **Engine 3 — Zarattini-Aziz-Barbon Noise Area Intraday Momentum (`10:00–15:00 ET` 60m top-of-hour grid, exclusively `QQQ` & `SMH`):**
   - Strictly disjoint symbol set from Engines 1 & 2, allowing concurrent co-held positions with per-cycle exit isolation and additive account headroom checks.
   - Causal 14-day minute-level `AvgSwing14[m]` at top-of-hour completed-bar checkpoints (`elapsed = 31, 91, 151, 211, 271, 331` minutes from `09:30 ET`), `UB = max(O, Cprev) × (1 + AvgSwing14[m])`, `LB = min(O, Cprev) × (1 - AvgSwing14[m])`, VWAP confirmation, max `1` entry per ETF/session.
   - Inverse-ATR weighted inside a `50%` gross sleeve budget (`[0.15, 0.32]` per leg), catastrophic funded protective stop `clamp(round(1.5 × ATR14_bps), 150, 600)`, `1500 bp` profit target, native broker-managed exits, flatten `15:58 ET` (`flattenMinuteFromOpen = 388`).
   - Verified out-of-sample over 3 years (`703` trading days, `2024–2026`, `6/6` positive half-years, `SR2 = +1.07`, `SR5 = +0.74`, `BE = +11.7 bp`, `DD = 3.5%`).

4. **Multi-Leg & Concurrent Execution Safety Fixes:**
   - Scoped `openingShort` authorization to the target symbol rather than whole-account flatness (`mutation-authority.ts`).
   - Grouped mutually exclusive OCO/bracket child legs by parent/order-class in pending sell coverage and gross exposure accounting (`mutation-authority.ts`).
   - Enabled margin buying power (`buyingPowerMicros`) for marginable equities on margin-enabled accounts while preserving strict cash caps for crypto/non-marginable assets.
   - Scoped entry-limit cancellation, exit reconciliation, protection completion, and `JevPurpose.Manage` inventory conservation to each cycle's owned symbols (`exitPolicy.plans`).

## 2. Production TypeScript 66-Session Offline Replay Verification (`2026-08-25` – `2026-11-25`)

The verifier (`services/bayn/tools/verify-intraday-alpha-replay.ts`) exercises production `buildTrailingBaseline`, `extractIntradayAlphaCandidates`, `selectIntradayAlphaLegs`, `makeIntradayAlphaFundedExitPlan`, `decodeJevPortfolio` (`concurrentDisjointPositions: true`), and `planTargets` (`executionPurpose: 'disjoint-entry'`) on $100,000 equity with whole-share quantities, conservative `T+2` post-decision opens, `±10 bp` entry/stop-limit collars, and 0.21 bp sell-side fees:

| Round-trip slippage | Active sessions | ORB30 trades & net | Midday MR trades & net | ZAB trades & net | Concurrent overlaps | Combined net P&L | SPY-Excess (Long / Short) | Three chronological folds | Max drawdown | Sharpe |
| ------------------- | --------------- | ------------------ | ---------------------- | ---------------- | ------------------- | ---------------- | ------------------------- | ------------------------- | ------------ | ------ |
| 2 bp                | 66/66           | 62, +$2,215        | 199, +$10,455          | 65, +$656        | 90                  | +$13,327         | +$7,338 / +$3,278         | +$2,031 / +$3,871 / +$7,424 | $1,623       | 4.45   |
| 5 bp                | 66/66           | 62, +$2,063        | 191, +$7,606           | 65, +$47         | 92                  | +$9,716          | +$6,069 / +$1,361         | +$1,360 / +$3,028 / +$5,328 | $2,507       | 3.41   |
| 10 bp               | 66/66           | 61, −$382          | 171, +$6,550           | 63, −$795        | 98                  | +$5,374          | +$3,788 / −$520           | +$190 / +$1,145 / +$4,038   | $2,768       | 1.92   |

All three chronological folds remain positive across `2`, `5`, and `10 bp` RT with `0` planner blocks and `90–98` concurrent multi-sleeve overlaps. (Under `T+1` open parity matching 10-second live submission into the active bar, 66-session net P&L is `+$16.1k–$17.5k` @ 2 bp, `Sharpe > 5.0`.)

## 3. Cutover & Live Activation Procedure

1. **PR 1 — Settle `v1` & Deploy `bayn.intraday-alpha-policy.v2` in `OBSERVE`:**
   - Migration `0222_intraday_alpha_v1_paper_settlement.ts` acquires the ordered transaction lock first, proves flat inventory, terminal cycles/intents, settled orders, complete accounting, and fresh exact reconciliation before restricting `bayn.intraday-alpha-policy.v1` to `OBSERVE` (`BLOCKED_STRATEGY_PROTOCOL_CUTOVER`).
   - Migration `0223_intraday_alpha_v2_admission.ts` runs after settlement while locks are already held, admitting `bayn.intraday-alpha-policy.v2`, `bayn.intraday-alpha-observation.v2`, `bayn.intraday-alpha-target.v2`, and `bayn.execution-risk-policy.v6` (`$180k` sandbox gross exposure cap).
   - Removes the retired `v1` `capital-activation-request` from `argocd/applications/bayn/alpaca-sealedsecret.yaml` and binds `nix/images/bayn.nix` and `argocd/applications/bayn/{deployment,execution-controller,execution-activation}.yaml` to the `bayn.intraday-alpha-policy.v2` (`behavior.v3`) and `bayn.execution-risk-policy.v6` hashes.
   - Merges to `main`, publishes the immutable image cohort via CI, promotes via Kargo `bayn` Stage (`kargo/bayn`), syncs via Argo CD, and verifies clean `OBSERVE / CLEAR` startup and exact reconciliation.
2. **PR 2 — Seal & Activate `PAPER / CLEAR` Mandate:**
   - Seals the account-bound `ResearchCapitalActivationRequest` referencing PR 1's exact published `sourceRevision`, `imageDigest`, `bayn.intraday-alpha-policy.v2` strategy identity, and `bayn.execution-risk-policy.v6` into `argocd/applications/bayn/alpaca-sealedsecret.yaml` with matching `proompteng.ai/bayn.mandate-identity` annotation.
   - Merges, promotes via Kargo/Argo CD, and verifies live `PAPER / CLEAR` authority running `bayn.intraday-alpha-policy.v2`.
