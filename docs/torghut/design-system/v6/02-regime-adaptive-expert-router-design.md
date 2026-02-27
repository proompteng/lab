# Regime-Adaptive Expert Router Design

## Status

- Doc: `v6/02`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: implement MM-DREX-style expert routing in Torghut with deterministic guardrails

## Objective

Implement a regime-aware routing layer that dynamically allocates weight across heterogeneous strategy experts and explicitly replaces static single-strategy capital assignment.

## Expert Set

1. `trend`: momentum and continuation behavior.
2. `reversal`: mean-reversion in over-extended conditions.
3. `breakout`: volatility expansion and range escape behavior.
4. `defensive`: low-risk static or reduced-exposure posture.

## Router Inputs

- time-series features (returns, volatility, realized correlation, drawdown state),
- microstructure features (spread, imbalance proxy, liquidity stress),
- event-context features (news density and freshness),
- changepoint probability.

## Router Output Contract

```json
{
  "symbol": "NVDA",
  "asOfUtc": "2026-02-27T15:31:00Z",
  "regimeLabel": "trend_up",
  "regimeConfidence": 0.78,
  "weights": {
    "trend": 0.62,
    "reversal": 0.14,
    "breakout": 0.20,
    "defensive": 0.04
  },
  "entropy": 0.41,
  "routerVersion": "router-v1"
}
```

Rules:

- all weights are in `[0,1]`,
- weight sum must equal `1.0` after normalization,
- invalid output fails closed to defensive posture.

## Decision Aggregation

Per symbol/time bucket:

1. score each expert independently,
2. apply router weights,
3. compute weighted intent,
4. pass result through deterministic risk/policy gates.

If router confidence is low or entropy is high, invoke slow-path DSPy committee before final intent.

## Training and Refresh Policy

### Offline training

- rolling window with strict forward splits,
- regime-balanced sampling,
- objective includes return quality and drawdown penalty.

### Online refresh

- periodic retraining cadence,
- drift triggers from distribution and performance monitors,
- promotion only through artifact registry and gate evidence.

## Failure Modes and Fallbacks

1. Router unavailable: use last known good router artifact; if unavailable, force defensive weights.
2. Router schema error: reject output and open severity alert.
3. Feature freshness breach: disable non-defensive experts for affected symbols.

## Observability

Required runtime metrics:

- `router_inference_latency_ms`
- `router_confidence`
- `router_entropy`
- `expert_weight_distribution`
- `regime_transition_rate`
- `router_fallback_count`

Required alerts:

- high fallback rate,
- prolonged high-entropy regime,
- abnormal concentration in one expert,
- stale features feeding router.

## Validation Plan

1. Replay tests across crisis/reversal windows.
2. Walk-forward evaluation by market regime.
3. Comparison against static TSMOM and static best-expert baselines.
4. Outage simulation verifying defensive fallback behavior.

## Exit Criteria

1. Router output contract is stable and versioned.
2. Weighted strategy outperforms static baseline on risk-adjusted metrics across forward windows.
3. Fallback and fail-closed behavior verified in integration tests and staged runtime drills.
