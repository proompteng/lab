# Transaction Costs and Capacity (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Ensure strategies remain profitable after costs and at scale.

## Cost Components
- Spread (half-spread paid on aggressive fills).
- Fees and rebates.
- Slippage from volatility during execution.
- Market impact (temporary and permanent).
- Borrow costs and shortability constraints.

## Capacity
Capacity is the notional you can deploy before impact erases edge.

Practical proxy metrics:
- participation rate,
- average daily volume vs trade size,
- expected impact per trade.

## Torghut Extensions
- Add a cost model module:
  - inputs: spread estimates from quotes, volatility, ADV.
  - outputs: expected cost bands used by risk engine and backtester.
- Record realized slippage and compare to model predictions.

## Cost Model MVP (Good Enough To Start)
Per order intent, estimate:
- `spread_cost_bps`: aggressive half-spread cost (or 0 for passive limit with fill risk).
- `vol_cost_bps`: volatility * expected execution time (simple proxy).
- `impact_cost_bps`: scaled with participation rate (trade_size / ADV).

Use the cost bands for:
- pre-trade veto (expected costs exceed expected edge),
- sizing throttles (reduce participation),
- strategy selection (avoid cost-sensitive strategies in wide-spread regimes).

## References
- Optimal execution with impact (foundational): https://docslib.org/doc/1384720/optimal-execution-of-portfolio-transactions
- Execution with market impact (Almgren-Chriss, 2001): https://www.math.nyu.edu/faculty/chriss/optliq_f.pdf
