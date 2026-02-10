# Strategy Universe (2026): Quant Strategy Map For Torghut

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Provide a strategy taxonomy and selection framework to avoid random experimentation.

Torghut should support multiple strategies, but each should be explicitly labeled by:
- holding period,
- data requirements,
- capacity constraints,
- typical regime behavior,
- failure modes.

## Strategy Taxonomy
- Trend / time-series momentum (medium horizon, crisis convexity potential).
- Mean reversion (intraday to multi-day; sensitive to regime shifts).
- Cross-sectional momentum / factor tilts (portfolio-level).
- Volatility targeting and defensive overlays.
- Market making / liquidity provision (microstructure intensive; higher operational risk).
- Event-driven (usually needs alternative data; higher complexity).

## Selection Criteria
- Edge plausibility: why should it persist?
- Cost sensitivity: does it survive spread and impact?
- Capacity: can it scale to desired notional?
- Robustness: does it work across symbols and regimes?
- Explainability: can we attribute PnL?

## How This Maps To Torghut
Torghut is currently a "signals from ClickHouse" system with a periodic loop, so it naturally supports:
- low-to-medium frequency intraday strategies,
- multi-asset portfolio strategies (if signals exist),
- disciplined execution using limit orders.

High-frequency market making is possible but would require:
- order book data ingestion,
- sub-second decisioning,
- more sophisticated execution safety and latency control.

## Initial Recommended Portfolio (Paper)
- One trend strategy and one mean-reversion strategy with strict risk caps.
- A volatility targeting overlay to keep risk stable.
- A regime filter controlling when each strategy is active.

## References
- Trend following and drawdowns framing: Man Group article (2024): https://www.man.com/maninstitute/why-do-trend-following-strategies-suffer-drawdowns
