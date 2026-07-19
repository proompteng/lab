# Bayn milestone 1 evidence

Evidence captured on 2026-07-19 before GitOps activation. This is a development/economic-gate run, not the excluded
locked out-of-sample verdict.

## Data

- Dataset: `alpaca-all-iex-2017-01-01-2026-07-18-v1`
- Source/feed/adjustment: Alpaca / IEX / all
- Table: `signal.adjusted_daily_bars_v1`
- Rows: 12,008 across the eight protocol ETFs
- Common usable coverage: 2020-07-27 through 2026-07-17
- Input manifest: `77ebec2b4188feeb8d44f301af531bf0c547e358e9320e81e7cd95af0ee29cf0`
- Ordered content hash: `8cb9bdb8cedf967b20312bad57204f0762034363cf9ed977db1e80790f74d2c8`

## Deterministic evaluation

- Run: `9b9f365d828cc55c971ee7a07fd361474bd729d888b721d919121a813ac17c2e`
- Comparable observations: 1,245
- Net annualized return: 6.291%
- Strategy Sharpe: 0.537
- Buy-and-hold Sharpe: 0.697
- Direct-volatility Sharpe: 0.688
- Maximum drawdown: 30.49%
- Annual turnover: 9.40x
- Doubled-cost annualized return: 5.805%
- Verdict: `FAIL_CLOSED` because benchmark Sharpe improvement failed; all other configured gates passed.

## Accounting and authority

- TigerBeetle accounts reconciled: 13
- TigerBeetle transfers reconciled: 767
- Posted balances, account set, and transfer set: exact
- An immediate replay of the same run returned the same run ID and exact reconciliation, proving idempotency.
- Broker orders: disabled by absence; no broker client or credential exists in Bayn.
- Capital promotion: disabled by absence.
