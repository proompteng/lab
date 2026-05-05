# Torghut Chip Universe Rollout - 2026-05-05

## Objective

Constrain Torghut live strategy catalogs and autoresearch search space to a semiconductor and chip-technology universe that is also covered by the live TA signal pipeline.

## Selected Universe

`NVDA, TSM, AVGO, AMD, MU, TXN, ADI, LRCX, KLAC, QCOM, AMAT, ASML`

## Selection Basis

- Nasdaq PHLX Semiconductor Sector Index describes SOX as covering companies primarily involved in semiconductor design, distribution, manufacture, and sale.
- VanEck SMH daily holdings as of 2026-05-04 were led by NVDA, TSM, AVGO, INTC, AMD, MU, TXN, ADI, LRCX, KLAC, QCOM, AMAT, and ASML.
- The executable list applies an active-trading quality filter instead of copying the ETF mechanically: keep ASML for critical lithography exposure and remove INTC/MRVL from the live research universe.
- iShares SOXX holdings in 2026 also supported AVGO, NVDA, MU, AMD, TXN, QCOM, and other semiconductor exposures as core liquid chip names.
- The production executable universe is capped at 12 symbols and must remain aligned across Jangar, WebSocket subscriptions, static fallbacks, checked-in strategy catalogs, and autoresearch configs.

## Explicit Exclusions

The strategy search and checked-in catalog should not include general mega-cap software, e-commerce, social, or SaaS tickers such as `AAPL`, `GOOG`, `META`, `MSFT`, `PLTR`, or `SHOP`. It should also exclude the removed lower-quality/tail chip names `INTC` and `MRVL` unless a future evidence review explicitly re-adds them.

## Production Constraint

This universe cleanup does not by itself prove the `$300/day` or `$500/day` profitability target. Any candidate generated from this universe still needs fresh empirical replay and promotion evidence before live promotion.
