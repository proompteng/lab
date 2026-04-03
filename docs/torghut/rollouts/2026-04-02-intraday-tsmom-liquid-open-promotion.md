# Torghut Intraday TSMOM Liquid-Open Promotion

## Date

April 2, 2026

## Summary

This document records the promotion of the `intraday-tsmom-profit-v3` repo candidate to the liquid-open variant that won the retained-data simulation window from Monday, March 30, 2026 through Thursday, April 2, 2026.

The promotion in this document is a checked-in strategy-catalog promotion only. It is not proof that the candidate is ready for live rollout, because replay conversion still materially exceeds production conversion in several names.

## Research Basis

The strategy direction is based on recent work emphasizing intraday concentration, liquidity leadership, and order-flow quality rather than broad symbol universes:

1. `2026-01-30`: [A unified theory of order flow, market impact, and volatility](https://arxiv.org/abs/2601.23172)
2. `2025-04-10`: [How Index Funds Reshape Intraday Market Dynamics](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID4716799_code999772.pdf?abstractid=3493513&mirid=1&type=2)
3. `2025-02-03`: [Intraday Returns Forecasting Using Machine Learning: Evidence from the Brazilian Stock Market](https://papers.ssrn.com/sol3/Delivery.cfm/06a2cf9c-01b0-49cd-bf72-dd39aff0f66e-MECA.pdf?abstractid=5122977&mirid=1)
4. `2025`: [Stock Turnover Leadership and Expected Returns](https://public.econ.duke.edu/~boller/Papers/MS_2025.pdf)

The design implication used here is:

- restrict the universe to higher-conversion liquid names
- trade the opening regime only
- require stronger microstructure confirmation
- reject lower-quality quote windows

## Production Calibration

April 2, 2026 production was used as the calibration anchor.

Regular session `2026-04-02 13:30:00Z` to `2026-04-02 20:00:00Z`:

- active strategy: `intraday-tsmom-profit-v2`
- `6,647` trade decisions
- `271` filled
- `6,362` rejected
- `14` canceled
- fill rate: `4.08%`

Production showed especially weak conversion in `INTC`, `PLTR`, `GOOG`, `MU`, and `SHOP`, so the candidate search focused on liquid open-window momentum and microstructure quality instead of the broader stale repo universe.

## Local Replay Baseline

Replaying the live April 2, 2026 cluster config locally produced:

- `166` decisions
- `178` fills
- `+$50.50393886747856733713256` net P&L

That baseline was profitable but not close to the target, and it still overstated conversion relative to production.

## Promoted Candidate

The promoted repo candidate uses:

- strategy name: `intraday-tsmom-profit-v3`
- strategy id: `intraday_tsmom_v1@prod`
- symbols: `NVDA`, `AAPL`, `MSFT`, `AMAT`, `META`, `AVGO`, `AMD`, `GOOG`, `PLTR`, `INTC`
- `max_notional_per_trade: 50000`
- `max_position_pct_equity: 3.0`

Key parameters:

- `entry_start_minute_utc: 810`
- `entry_end_minute_utc: 930`
- `max_spread_bps: 20`
- `min_recent_imbalance_pressure: 0.02`
- `min_recent_microprice_bias_bps: 0.10`
- `max_recent_quote_invalid_ratio: 0.20`
- `min_cross_section_opening_window_return_rank: 0.60`
- `min_cross_section_continuation_rank: 0.60`

## Simulation Result

Retained-data week simulation, Monday March 30, 2026 through Thursday April 2, 2026:

- total net P&L: `+$1650.54400120226958906935927`
- average net P&L per day: `+$412.6360003005673972673398175`
- decisions: `58`
- fills: `64`

Daily net P&L:

- `2026-03-30`: `-$219.1886569944122196997114217`
- `2026-03-31`: `+$978.7489920448298212829663466`
- `2026-04-01`: `-$599.1258088615208784720325819`
- `2026-04-02`: `+$1490.109475013372865958136967`

Simulation artifact:

- `/var/folders/lw/8xxlfdz912zbk9xk6vm4f1h80000gn/T/liq10_n50k_x3.json`

## Promotion Boundaries

This repo promotion does not remove the major execution risk:

- replay conversion materially exceeds production conversion
- the checked-in Argo strategy catalog is out of sync with the live cluster catalog
- April 2, 2026 close-to-close account equity was negative even though regular-session equity delta was positive

The next required step before real rollout is historical-simulation playbook validation on this exact candidate through the production-style execution path.
