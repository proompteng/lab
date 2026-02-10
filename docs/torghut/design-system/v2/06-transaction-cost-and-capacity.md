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

## References
- Optimal execution with impact (foundational): https://docslib.org/doc/1384720/optimal-execution-of-portfolio-transactions
