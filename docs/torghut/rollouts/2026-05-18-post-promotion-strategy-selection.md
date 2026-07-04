# Torghut Post-Promotion Strategy Selection

## Status

- Date: 2026-05-18
- GitOps revision observed: `13bb93ee2f80d1beb1fdd11cafa0ec7b1ee9b09d`
- Runtime build observed: `v0.571.1-105-ga7f6c5b1c`
- Runtime commit observed: `a7f6c5b1c45b69543bbf19f5d3c7224dfc50e96a`
- Runtime image digest observed: `sha256:93ffbdfc9e8b93b7f2b909b4fdb28d5da5dadffc75ae324b928cce0437a2a28f`

## Current Best Candidate

The best current research candidate is `spec-83161ae16d17828eabcc58cc`, mapped by the checked-in
`H-TSMOM-01` manifest to the `intraday_tsmom_consistent` family and the
`intraday-tsmom-profit-v3` runtime harness.

Evidence:

- Latest production `autoresearch_proposal_scores` epoch ranked `spec-83161ae16d17828eabcc58cc`
  first with proposal score `2.52157822`.
- `H-TSMOM-01` has production lineage in `strategy_hypotheses` and a paper-runtime metric window.
- `H-PAIRS-01` / `spec-d74b07b2aaab8d0cfa8a4c38` is not the best current candidate: production
  lineage is still missing, no current metric window exists, and the inspected sim window produced
  no `microbar-cross-sectional-pairs-v1` decisions.

This is not a live-promotion approval. The active `/trading/status` still reports
`live_submission_gate.allowed=false` with blockers including `hypothesis_not_promotion_eligible`
and `simple_submit_disabled`. `H-TSMOM-01` is the nearest candidate to repair and validate, not a
strategy with current live-capital authority.

## Acceptable Promotion Parameters

Use the `portfolio-profit-autoresearch-500-v1` objective as the promotion standard:

- Target net PnL: at least `$500/day` post cost, measured per trading day, not cumulative headline PnL.
- Active day ratio: at least `0.90`.
- Positive day ratio: at least `0.60`.
- Minimum daily notional: at least `$300,000`, unless a lower-notional paper probe is explicitly scoped
  as repair evidence only.
- Best-day concentration: no single day may contribute more than `25%` of total PnL.
- Worst day loss: normal cap `5%` of start equity; extended review cap `8%`.
- Max drawdown: normal cap `10%` of start equity; extended review cap `15%`.
- Net-PnL-to-drawdown ratio: at least `2.00`.
- Gross exposure: no more than `100%` of start equity.
- Cash: must not go negative.
- Runtime closure: checked-in runtime family, scheduler parity replay, scheduler approval replay,
  live-shadow validation, and fresh empirical metric windows.
- Execution evidence: positive post-cost expectancy, TCA/slippage within manifest budget, fresh signal
  continuity, drift checks recent, and shadow parity within budget.

External drawdown research supports this posture: professional and retail trading references generally
place ordinary acceptable drawdowns around `10%` to `20%`, with more conservative automated or
capital-preservation strategies closer to `10%`. Torghut should therefore keep `10%` as the normal
promotion cap and treat `15%` as an extended-review ceiling, not a default allowance.

## H-TSMOM Promotion Parameters

For `H-TSMOM-01` specifically, promotion repair should use:

- Strategy family: `intraday_tsmom_consistent`.
- Runtime strategy: `intraday-tsmom-profit-v3`.
- Candidate id: `spec-83161ae16d17828eabcc58cc`.
- Dataset snapshot ref: `portfolio-profit-autoresearch-500-v1`.
- Max allowed slippage: `6 bps`.
- Max rolling drawdown: `1000 bps`.
- Minimum samples for live canary: `60`.
- Minimum samples for scale-up: `120`.
- Entry freshness: signal lag at most `90 seconds`; evidence age at most `30 minutes`.
- Required features: trend strength, intraday momentum rank, realized volatility, turnover, and TCA.

The frontier sweep currently allows `intraday_tsmom_consistent` candidates with a holdout target of
`$300/day`, worst holdout day loss up to `$200`, profit factor at least `1.1`, and consistency drawdown
up to `$600`. Those are search filters, not promotion authority. The promotion bar remains the
portfolio-level `$500/day` and drawdown policy above.

## Next Repair Target

The next production work should make the paper runtime produce fresh, executable TCA-backed decisions
for `intraday-tsmom-profit-v3`. Current evidence windows contain zero orders/trades and zero TCA rows,
so renewing imports alone cannot make the strategy promotable.

## References

- CFI maximum drawdown overview: https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/maximum-drawdown/
- BacktestBase drawdown risk guide: https://www.backtestbase.com/education/drawdown-risk-analysis
- TradingStrategy.ai Calmar ratio overview: https://tradingstrategy.ai/glossary/calmar-ratio
