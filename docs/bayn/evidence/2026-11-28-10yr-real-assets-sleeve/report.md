# Wave 24B: daily real-assets sleeve

**Research question:** Can a fixed next-open real-assets rule deliver positive returns independent of
B0, F4, and O1 during equity and rates drawdowns, and add Sharpe and Calmar to their combined book?

## Preregistered protocol

The only candidate price source is the digest-bound Alpaca SIP split-and-dividend-adjusted daily
tape at `s3://agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Require manifest
membership, ordered unique positive marks, and every one of the 2,741 registered sessions for
GLD, SLV, DBC, USO, TIP, XLE, and SHY, and for the SPY and IEF reference ETFs. A manifest-only check
before registration found TIP missing. If and only if TIP is absent from both the manifest and the
authenticated tape, score a **separate six-ETF diagnostic** with no tradable TIP. It cannot clear
the seven-ETF coverage gate. Any other missing or partial coverage aborts. Do not use the sibling
TIP supplement, another instrument as a TIP proxy, or imputed marks.

- **Allocation.** One fixed long-only rule. At each close, qualify each ETF whose adjusted close
  exceeds its own close 126 sessions earlier. Split half the capital equally among qualifying
  GLD and SLV. The other half rotates: when the DBC/SHY close ratio has risen over 63 sessions,
  split it among qualifying DBC, USO, and XLE; otherwise use qualifying TIP. This is a
  market-price inflation-pressure signal, not an observed CPI or breakeven series. Allocate
  any empty budget (including the inactive TIP slot in the diagnostic) to actual SHY, also the
  initial warmup holding. No leverage or short positions.
- **Execution.** Use the previous close to value current holdings, fix target share orders,
  and require the larger of buy or sell requests to be at least 10% of NAV. At the next open,
  sell the requested shares and fill the submitted buy quantities up to available cash and
  sale proceeds, scaling all buys by the same fraction if necessary. An open cannot change
  the order decision or increase a requested quantity. Mark close-to-close; retain prior
  holdings through the opening gap and carry underspends as cash at zero yield. Fractional
  fills at archived opening marks, simultaneous sale funding, and no market impact are
  modeled assumptions, not verified auction execution.
- **Costs.** Charge 0 / 2 / 5 / 10 bp one-way on every sleeve dollar bought or sold, including the
  first SHY entry. The 10 bp one-way tier is primary. Fix B0, F4, and O1 at their native 10 bp
  _round-trip_ slippage plus their existing fees at every tier. Verify their published split
  totals first. B0 daily return is replay P&L divided by its published fixed capital; F4 and O1
  keep their published SHY idle rules. The comparator replays use their own pinned inputs;
  those inputs do not add tickers to the real-assets universe.
- **Walk-forward.** Score chronological intervals 2016-01-05 to 2021-12-31 (development),
  2022-01-03 to 2023-12-29 (first forward fold), and 2024-01-02 to 2026-11-25 (final holdout).
  The first archive close is only an input to the next session; development includes the SHY
  warmup. No tuning, refits, or ledger resets at fold boundaries. Pool the last two folds for
  OOS diagnostics and also report calendar 2022. This is a historical walk-forward test, not
  a newly embargoed archive or prospective trial.
- **Stress.** Label a session by the previous close: SPY at least 5% below its trailing
  63-session closing high (equity); IEF at least 3% below its equivalent high (rates); or both
  (joint). The trailing window includes that close. Report session counts and conditional
  mean net and excess-SHY bps/session, not an annualized return on disjoint days. IEF is an
  intermediate-Treasury ETF reference, not a direct yield or CPI measure.
- **Attribution.** Compare equal daily weights in B0/F4/O1 against 25% in each of
  B0/F4/O1/real assets, and against the same 25% allocation to passive SHY instead.
  Charge the sleeve's one-way tier on all virtual capital transfers implied by prior
  closing weights. Report arithmetic contributions in bps/session, including transfer drag;
  they sum to daily net and are not a decomposition of compounded wealth. Passive SPY, IEF,
  and SHY benchmarks have no internal trading costs. Blends are matched return paths, not
  a joint order, capital, or margin simulation.
- **Inference and decision.** Compute compounded returns, CAGR and sample Sharpe at 252
  sessions/year (zero risk-free rate), max drawdown, Calmar, and Pearson correlations.
  On the final holdout use 5,000 paired circular stationary draws (mean 10 sessions, seed
  `0x24b2026`). Test the centered mean sleeve-minus-SHY return against zero and use the
  fifth percentile of the paired Sharpe difference against the base as a one-sided 95% lower
  bound. At 10 bp require complete seven-ETF coverage, positive pooled OOS excess over SHY
  and holdout excess mean p < 0.05, positive calendar-2022 return and positive pooled joint
  stress mean both absolute and excess over SHY, holdout absolute correlations ≤ 0.30 to
  **each** of B0/F4/O1, and holdout Calmar lift and positive Sharpe lower bound against the
  base. The sleeve blend must also beat the SHY blend on point Sharpe and Calmar. No
  substitutions, threshold changes, or verdicts based on another cost tier after scoring.
