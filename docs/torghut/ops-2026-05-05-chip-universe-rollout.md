# Torghut Chip Universe Rollout - 2026-05-05

## Objective

Constrain Torghut live strategy catalogs and autoresearch search space to a semiconductor and chip-technology universe that is also covered by the live TA signal pipeline.

## Selected Universe

`AMAT, AMD, AVGO, INTC, MU, NVDA`

## Selection Basis

- Nasdaq PHLX Semiconductor Sector Index describes SOX as covering companies primarily involved in semiconductor design, distribution, manufacture, and sale.
- VanEck SMH daily holdings in April 2026 were led by NVDA, TSM, AVGO, AMD, and ASML, supporting the AI accelerator, foundry, and equipment core.
- iShares SOXX holdings in April 2026 included AVGO, NVDA, MU, AMD, TXN, and QCOM among major semiconductor exposures.
- Nasdaq SOX fact sheet constituents include semiconductor equipment and manufacturing names such as LRCX, ASML, AMAT, MU, and KLAC.
- The production executable universe is narrowed to the semiconductor names with current `ta_signals` and `ta_microbars` coverage in the live ClickHouse pipeline. Do not advertise names such as `ASML`, `KLAC`, `LRCX`, `QCOM`, `TSM`, or `TXN` until the data path is verified for them.

## Explicit Exclusions

The strategy search and checked-in catalog should not include general mega-cap software, e-commerce, social, or SaaS tickers such as `AAPL`, `GOOG`, `META`, `MSFT`, `PLTR`, or `SHOP`.

## Production Constraint

This universe cleanup does not by itself prove the `$300/day` or `$500/day` profitability target. Any candidate generated from this universe still needs fresh empirical replay and promotion evidence before live promotion.
