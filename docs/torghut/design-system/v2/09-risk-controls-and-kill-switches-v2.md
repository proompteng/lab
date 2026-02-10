# Risk Controls and Kill Switches (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Upgrade from "toggle trading" to a true market-access safety layer.

## Required Controls (Autonomous)
- Pre-trade order firewall (single module allowed to place/cancel orders).
- Max order size, max notional, max daily loss.
- Max message rate, max cancel/replace rate.
- Hard kill: cancel open orders + block new orders.
- Per-strategy and per-symbol circuit breakers.

## Torghut Extensions
- Split responsibility:
  - Strategy decides intent.
  - Risk engine approves intent.
  - Order firewall executes and can unilaterally reject.
- Add a broker-side kill path (cancel all open orders) that is callable without deploying code.

## References
- SEC Market Access Rule 15c3-5 (risk management controls): https://www.sec.gov/rules-regulations/2011/06/risk-management-controls-brokers-or-dealers-market-access
- MiFID II RTS 6 (algo trading controls and kill functionality): https://eur-lex.europa.eu/eli/reg_del/2017/589/oj/eng
