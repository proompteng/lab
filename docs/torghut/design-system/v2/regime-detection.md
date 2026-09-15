# Regime Detection and Risk-On/Risk-Off Controls (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**
- Audit update: **2026-02-26**

## Purpose

Reduce drawdowns by recognizing when a strategy's assumptions are failing.

## Regime Signals (Pragmatic)

- Volatility level and change rate.
- Correlation spikes across symbols.
- Trend strength metrics vs choppy conditions.
- Liquidity proxies: spread widening and gap frequency.

## Control Actions

- Throttle size (reduce risk budgets).
- Stop opening new positions.
- Flatten high-risk symbols.
- Switch strategies (trend vs mean reversion) when a regime flips.

## Torghut Extensions

- Regime classification and scheduler integration are implemented.
- Runtime status surfaces regime-informed state and controls.
- Remaining work is deeper calibration/persistence standardization across all rollout lanes.

## Failure Modes

- Overfitting the regime classifier.
- Flip-flopping (too sensitive), causing churn.

## References

- Managed futures discussion of trend behavior across cycles: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
