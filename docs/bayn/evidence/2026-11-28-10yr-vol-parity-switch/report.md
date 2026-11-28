# Wave 24A: realized-volatility and equity–bond parity switch

**Goal:** Test whether a daily next-open switch earns positive net market-model alpha or improves Calmar and maximum
drawdown when added to the incumbent Bayn sleeves. This is a historical research screen, not trading authority.

**Verdict: DO NOT PROMOTE.** The switch improved the point estimate for pooled OOS drawdown, but neither the
alpha nor diversification route cleared the registered gates at any nonzero cost.

## Pre-registered protocol

### Data and walk-forward windows

- The only candidate prices are `SPY, QQQ, TLT, IEF, SHY, GLD` from the adjusted Alpaca SIP daily tape in
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Verify the manifest, all six memberships,
  compressed and decoded tape receipts, and exactly one valid bar per asset per session on the pinned calendars.
  No supplement, forward fills, or proxies for these six assets. The DIA/UUP supplement and the split-adjusted
  intraday tapes are only for the incumbent controls.
- The tape spans 2016-01-04 through 2026-11-25 (2,741 sessions). Use 2016–2019 as the initial history and
  descriptive development window. Advance once through three disjoint OOS windows: 2020-01-02–2021-12-31 (505
  sessions), 2022-01-03–2023-12-29 (501), and 2024-01-02–2026-11-25 (729). Carry state and trailing history forward;
  use only information before each execution and never fit on the score window. There is no grid search, refit, or
  alternate candidate. Results from all 1,735 OOS sessions in sequence form the primary comparison.
- Replay controls from the first tape date, check the published B0/F4/O1 fold totals, and compare every path on the
  identical 2,719 sessions (from the first eligible open, 2016-02-04). The full window includes development; the
  latest OOS window is a stability check, not blind to the wider historical Bayn research program.

### Signal, portfolio and frictions

1. At session close use the latest 21 simple adjusted close-to-close returns, including that close. Realized
   volatility is sample standard deviation times √252. Initialize calm; enter stress at SPY volatility **≥20%**,
   return to calm at **≤15%**, and retain the previous regime in between. Stay in cash until 21 returns exist.
2. Compute the same volatility for the equal-weight SPY/QQQ and TLT/IEF daily return baskets. Divide the parity
   sleeve between the two baskets in inverse proportion to their volatilities, with equal weights within each
   basket. Calm allocates 90% to parity, 5% to SHY and 5% to GLD; stress allocates 40%, 45% and 15% respectively.
   Run an always-calm parity comparator with the same timing and costs to isolate the value of switching.
3. Use closing marks and current positions to decide whether the larger of buy or sell notional implied by the
   target is at least 2% of NAV. If it is, execute at the **next** recorded open, not the signal close. Old positions
   earn the overnight move; new positions earn the open-to-close move. Close-to-close portfolio returns are dated
   by the ending session. No leverage, short positions, interest on warm-up cash or terminal liquidation.
4. Stress **0 / 2 / 5 / 10 bp round-trip** slippage, half on each actual buy and sell dollar, plus 0.21 bp on sales
   in every case. Both buys and sells are funded out of the portfolio after fees. Use the existing B0 (QQQ/SMH
   intraday, native fixed-$100k P&L divided by $100k), F4 (`F4-42-1-LQD-parity`, SHY-idle) and O1
   (`ensemble/base/21/0.05`, SHY-idle) replays at matching slippage; SPY is frictionless total return.

### Measurements and decision

- Compound daily net returns; annualize CAGR by 252/session count, Sharpe by √252, and one-way turnover by 252.
  MaxDD is positive peak-to-trough loss from a starting NAV of 1; Calmar is CAGR / MaxDD. Net alpha is the ex-post
  OLS intercept of switch-minus-SHY against SPY-minus-SHY, annualized arithmetically by 252. SHY is a traded
  short-duration comparator, not a pure risk-free rate; this single market factor does not control for duration,
  gold or other exposures. The regression never feeds a trading decision.
- Measure Pearson correlation against SPY, B0, F4, O1, and the equal B0/F4/O1 basket. Compare each with a fixed
  25% allocation to the switch, reducing the incumbent weights pro rata. Reset sleeve weights every session,
  charging half the round-trip cost on gross transfers. These are separately funded return-path diagnostics, not
  simulated joint fills, intraday netting, or evidence that overlapping instruments or exposures cancel.
- For pooled OOS, use paired [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870) with 5,000
  circular resamples, mean block 10 sessions, seed `0x24a2026`, and 2.5th/97.5th percentile intervals. Resample the
  actual matched session paths together; refit alpha and recompute compound-path Calmar/MaxDD on each draw. The
  intervals are conditional on this historical path and block choice and do not correct for prior Bayn studies.
- **PROMOTE** only if the _same_ route passes at all of 2, 5, and 10 bp:
  - **Alpha:** pooled OOS net CAGR and alpha lower bound are positive, and alpha is positive in every OOS window.
  - **Diversification:** for the equal B0/F4/O1 basket with a 25% switch allocation, both paired lower bounds are
    positive (blend minus incumbent Calmar, incumbent minus blend MaxDD); both point improvements hold in the
    latest OOS window; pooled annual CAGR drag is at most 1 percentage point; and pooled absolute correlation
    between the switch and the incumbent basket is at most 0.50.
- Undefined required evidence cannot pass. Otherwise the verdict is **DO NOT PROMOTE**. The always-calm comparator,
  individual blends, full-window measurements, and 0 bp scenario cannot substitute for the gate. Even a pass would
  only justify separate prospective evaluation.

## Executed results

The replay authenticated 450,712 rows in the base archive and verified 2,741 bars per required asset
(16,446 candidate bars) on the pinned calendars. It reproduced the published B0, F4, and O1 split totals
before comparisons. The switch spent 2,010 scored sessions calm and 709 in stress; it rebalanced 534 times at
each cost, including the initial fill. [Results](results.json) retains receipts, oracle comparisons, path digests,
and unrounded statistics for all costs and windows.

### Standalone switch

Pooled OOS, 1,735 sessions. Alpha and its paired 95% interval are annualized arithmetic percentages.

| Round trip | Net CAGR | Sharpe | Calmar |  MaxDD | Net alpha | 95% alpha interval |
| ---------: | -------: | -----: | -----: | -----: | --------: | ------------------ |
|       0 bp |    5.84% |  0.766 |  0.374 | 15.61% |    +1.45% | [−2.78%, +5.65%]   |
|       2 bp |    5.79% |  0.760 |  0.371 | 15.64% |    +1.40% | [−2.82%, +5.60%]   |
|       5 bp |    5.72% |  0.751 |  0.365 | 15.68% |    +1.33% | [−2.88%, +5.53%]   |
|      10 bp |    5.59% |  0.735 |  0.355 | 15.76% |    +1.21% | [−2.99%, +5.40%]   |

At 5 bp, the always-calm parity comparator had 5.19% OOS CAGR, 0.212 Calmar, and 24.47% MaxDD. The switch
improved all three point estimates while increasing annual one-way turnover from 1.83× to 2.38× NAV. Across
the full scored window including development, the switch earned 6.59% CAGR, 0.954 Sharpe, and 15.68% MaxDD.
The full-window figures are descriptive, not additional OOS evidence.

| OOS window, 5 bp      | Sessions | Net CAGR |  MaxDD | Annualized alpha |
| --------------------- | -------: | -------: | -----: | ---------------: |
| 2020–2021             |      505 |   10.30% |  8.17% |           +5.93% |
| 2022–2023             |      501 |    0.68% | 15.64% |           +0.15% |
| 2024–2026 (to Nov 25) |      729 |    6.16% |  6.37% |           −1.11% |

The **alpha limiters** were a nonpositive lower interval bound and negative alpha in the latest fold at every cost.
The pooled point estimate was positive, not a reliable market-adjusted edge. Even at 0 bp slippage, the estimated
alpha interval crossed zero; the verdict did not turn on the slippage estimate.

### Fixed 25% blends

Change from each unblended comparator on pooled OOS at 5 bp. A positive MaxDD reduction means less drawdown.

| Comparator         | Correlation | CAGR change | Calmar change | MaxDD reduction |
| ------------------ | ----------: | ----------: | ------------: | --------------: |
| SPY                |       0.550 |    −1.82 pp |        +0.043 |        +7.19 pp |
| B0                 |      −0.012 |    −0.86 pp |        +0.278 |        +3.18 pp |
| F4                 |       0.656 |    −0.57 pp |        +0.067 |        +1.42 pp |
| O1                 |       0.552 |    −0.21 pp |        +0.063 |        +3.87 pp |
| Equal B0 + F4 + O1 |       0.507 |    −0.61 pp |        +0.054 |        +1.16 pp |

For the primary equal-incumbent comparison at 5 bp, MaxDD fell from 9.22% to 8.06% and Calmar rose from 0.903
to 0.956, but CAGR fell from 8.32% to 7.71% and Sharpe from 1.468 to 1.397.

| Round trip | Primary Calmar lift (95% interval) | MaxDD reduction (95% interval) | Latest Calmar lift |
| ---------: | ---------------------------------- | ------------------------------ | -----------------: |
|       0 bp | +0.025 [−1.050, +0.289]            | +1.13 pp [−1.66, +1.92]        |             −0.213 |
|       2 bp | +0.037 [−0.921, +0.299]            | +1.14 pp [−1.71, +1.99]        |             −0.204 |
|       5 bp | +0.054 [−0.760, +0.315]            | +1.16 pp [−1.80, +2.14]        |             −0.129 |
|      10 bp | +0.080 [−0.510, +0.330]            | +1.19 pp [−1.91, +2.53]        |             −0.020 |

The **diversification limiters** were both paired intervals crossing zero, worse latest-fold Calmar, and
correlation above the 0.50 maximum (0.506–0.507 at nonzero costs). The CAGR drag was within the registered
1 pp allowance at all nonzero costs. The near-zero B0 correlation is a pair-specific diagnostic, not
orthogonality to the full incumbent portfolio.

## Reproduce and interpret

From the repository root with read-only access to the pinned artifacts bucket:

```sh
run=$(mktemp -d)
bun services/bayn/tools/research-10yr-vol-parity-switch.ts --output "$run/results.json"
bunx oxfmt --config .oxfmtrc.json "$run/results.json"
cmp "$run/results.json" docs/bayn/evidence/2026-11-28-10yr-vol-parity-switch/results.json
rm -r "$run"
```

Two complete S3 replays produced byte-identical unformatted results. Truncating the verified daily tape at the
three walk-forward seams produced exactly the same signals and marked daily returns through each seam
as the full tape at every cost. The first execution was on 2016-02-04 from the 2016-02-03 close; every scored
execution decision used its prior session's close signal.

The archive provides adjusted historical bar marks, not a point-in-time arrival or correction audit. The
next-open model gives fractional execution at observed opening marks, with no quote, auction capacity, order
latency, or size-dependent impact model. Bootstrapped blocks omit neither losses nor idle sessions, but the
sample covers only these historical regimes, and peak-to-trough statistics are sensitive to how blocks join.
Do not use this report as a fill, leverage, or capital authorization decision.
