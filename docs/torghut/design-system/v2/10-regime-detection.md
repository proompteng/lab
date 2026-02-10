# Regime Detection and Risk-On/Risk-Off Controls (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

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
- Add a RegimeService that writes a low-frequency regime state to Postgres.
- Expose regime state in `/trading/status`.
- Make risk engine aware of regime state (hard clamps).

## Failure Modes
- Overfitting the regime classifier.
- Flip-flopping (too sensitive), causing churn.

## References
- Managed futures discussion of trend behavior across cycles: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
