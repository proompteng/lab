# Beyond TSMOM System Architecture and Latency Model

## Status

- Doc: `v6/01`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: replace static intraday TSMOM loop with a layered regime-adaptive system plus fast/slow decision routing
- Implementation status: `Partial`
- Evidence:
  - `services/torghut/app/trading/features.py`
  - `services/torghut/app/trading/forecasting.py`
  - `services/torghut/app/trading/scheduler.py`
  - `services/torghut/app/trading/portfolio.py`
  - `services/torghut/app/trading/regime.py`
- Rollout gap: missing first-class HMM control-plane and promotion lane that enforces this architecture as the dominant live path.

## Objective

Define a production architecture that keeps the strengths of TSMOM while addressing known intraday failure modes:

- regime blindness during reversals,
- static position scaling under microstructure shifts,
- no integration of unstructured context,
- delayed reaction to momentum crashes.

## Current Baseline and Gaps

Baseline components in Torghut are strong on deterministic safety and execution policy, but alpha generation is still narrow relative to current research.

Primary gaps:

1. Single dominant trend signal family in stressed regimes.
2. Limited dynamic strategy weighting by detected market state.
3. LLM reasoning exists but is not yet fully unified under one production program runtime and artifact lifecycle.
4. Limited formal contamination controls across all strategy and LLM eval surfaces.

## Target Layered Architecture

### Layer A: Enhanced Momentum Core

Replace static trend estimators with a learned momentum core inspired by DMN + MTL-TSMOM + MTDP:

- learned trend state encoder,
- joint sizing head optimized on risk-adjusted objective,
- changepoint feature channel for abrupt regime transition detection,
- auxiliary tasks (volatility and drawdown forecasting) to improve generalization.

### Layer B: Regime-Adaptive Expert Router

Wrap momentum as one expert among multiple experts:

- trend expert,
- mean-reversion expert,
- breakout/volatility-expansion expert,
- defensive/static allocation expert.

A router produces dynamic weights per symbol and time bucket.

### Layer C: LLM Reasoning Overlay

Use DSPy multi-agent reasoning only when needed:

- ambiguous or conflicting expert outputs,
- elevated uncertainty,
- high-impact event windows (news, macro, earnings).

### Layer D: Deterministic Decision and Execution

All model outputs are advisory inputs to deterministic controls:

- policy gates,
- risk limits,
- execution limits,
- kill switches.

## Fast/Slow Inference Model

### Fast path (routine)

- latency budget: `< 100ms`
- inputs: market microstructure + expert outputs + router weights
- behavior: deterministic scoring + action if confidence and risk gates pass

### Slow path (reasoning)

- latency budget: `1s` to `5s`
- inputs: fast-path bundle plus fundamentals/news and LLM committee context
- behavior: DSPy committee produces structured advisory critique and confidence

### Slow path trigger conditions

At least one must be true:

1. Router entropy exceeds configured threshold.
2. Expert disagreement exceeds configured spread.
3. Regime transition probability exceeds configured threshold.
4. News/fundamental freshness is recent and relevance score is high.
5. Position/risk impact of the proposed trade is above critical notional.

## Data and Interface Contracts

### Symbol-state contract (runtime)

- `symbol`
- `asOfUtc`
- `regimeLabel`
- `regimeProbabilities`
- `expertScores`
- `routerWeights`
- `uncertaintyScore`
- `contextFreshness`

### Decision-intent contract (pre-execution)

- `intent` (`buy|sell|hold|abstain`)
- `confidence`
- `positionDelta`
- `riskBudgetRef`
- `llmAdvisoryRef` (optional)
- `gateInputsHash`

## Engineering Deliverables

1. Feature contract update for regime and uncertainty fields.
2. Router integration in strategy decision loop.
3. Slow-path trigger evaluator with deterministic criteria.
4. End-to-end telemetry on path selection (`fast|slow`) and outcomes.

## Acceptance Criteria

1. Fast-path p95 latency stays within budget during market hours.
2. Slow-path invocation stays within configured rate cap and does not degrade scheduler health.
3. Regime-aware routing reduces drawdown in known reversal windows versus static TSMOM baseline.
4. All new decision fields are represented in audit artifacts and replay tooling.

## Research Inputs

- Deep Momentum Networks (Lim et al.)
- MTL-TSMOM
- MTDP changepoint-augmented momentum designs
- MM-DREX regime-adaptive routing
- FPX fast/slow model selection findings
