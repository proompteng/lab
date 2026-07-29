# Candidate 8 research: shrinkage minimum-variance allocation

Status: **rejected before preregistration and before development evaluation**

This is the terminal research record for the Candidate 8 lane started from source base
`accb27558050bec396f2ac963db951ca82c808b7` and finalized on exact main
`51a38cee5ecd0af1f6919b27723b6bd73df6d301`. The hypothesis passed the research and causal-implementability screen, but
the exact development sample cannot satisfy Bayn's existing walk-forward gate. No Candidate 8 preregistration was
sealed, no development or holdout return was evaluated, and no trial identity entered the durable qualification
lineage.

## Single researched hypothesis

The hypothesis was that stable cross-asset covariance information can support a long-only **shrinkage
minimum-variance** allocation with better net risk-adjusted performance than simple diversification, without forecasting
the direction of any asset's return. A causal implementation would estimate a shrunk covariance matrix from 63 finalized
close-to-close daily returns, solve one constrained minimum-variance allocation across `DBC,EFA,IEF,SPY,VNQ` at each
official month-end close, and execute the resulting rebalance at the next official session open.

The economic mechanism is diversification across imperfectly correlated economic risk exposures, with covariance
shrinkage reducing estimation error. Markowitz establishes portfolio variance as a function of asset variances and
covariances. Ledoit and Wolf show that shrinking a noisy sample covariance matrix toward a structured estimator can
produce materially lower out-of-sample portfolio variance. DeMiguel, Garlappi, and Uppal show that estimation error can
erase the apparent benefits of optimized portfolios relative to `1/N`; that result motivated omitting expected-return
estimation and retaining equal-weight buy-and-hold as a required benchmark rather than assuming optimization is
superior.

Primary sources:

- Harry Markowitz, “Portfolio Selection,” _The Journal of Finance_ 7 (1952), 77–91:
  <https://doi.org/10.1111/j.1540-6261.1952.tb01525.x>.
- Olivier Ledoit and Michael Wolf, “Improved estimation of the covariance matrix of stock returns with an application to
  portfolio selection,” _Journal of Empirical Finance_ 10 (2003), 603–621:
  <https://doi.org/10.1016/S0927-5398(03)00007-0>.
- Victor DeMiguel, Lorenzo Garlappi, and Raman Uppal, “Optimal Versus Naive Diversification: How Inefficient Is the 1/N
  Portfolio Strategy?”, _The Review of Financial Studies_ 22 (2009), 1915–1953:
  <https://doi.org/10.1093/rfs/hhm075>.

This is materially different from Candidates 5–7. It has no own-market trend signal, calendar-conditioned reversal,
cross-sectional winner ranking, absolute-strength filter, or expected-return forecast. Allocation is determined only by
the trailing covariance estimate and explicit long-only constraints.

## Causal geometry screened before preregistration

Only geometry-relevant behavior was fixed for this screen:

- development data boundary: `2016-01-04` through `2022-12-30`;
- adjusted-daily source universe: `DBC,EFA,IEF,SPY,VNQ`;
- feature history: 63 finalized close-to-close returns;
- decision schedule: final official session of each calendar month;
- execution: next official session open;
- Bayn policy: 504 training observations, 252 observations per non-overlapping test fold, and at least five folds.

The exact required observation count is therefore:

`504 + (252 * 5) = 1,764`.

The bounded official-session source contains only 1,762 distinct sessions. This makes the protocol impossible even
under a zero-lookback, zero-latency upper bound: `floor((1,762 - 504) / 252) = 4` folds, two observations short of the
required fifth fold.

The actual Candidate 8 schedule is stricter. With 63 return observations, the first eligible official month-end signal
is `2016-04-29` at session index 81, and next-session execution is `2016-05-02` at index 82. Bayn's simulator records one
comparable observation for every session from `startIndex`, so the maximum possible comparable series is
`1,762 - 82 = 1,680` observations. That permits four folds and is 84 observations short of the required 1,764.

| Geometry                                          | Value |
| ------------------------------------------------- | ----: |
| Bounded official development sessions             | 1,762 |
| Required observations for five walk-forward folds | 1,764 |
| Zero-lookback upper-bound folds                   |     4 |
| Zero-lookback observation deficit                 |     2 |
| Candidate 8 first execution index                 |    82 |
| Candidate 8 maximum comparable observations       | 1,680 |
| Candidate 8 available folds                       |     4 |
| Candidate 8 observation deficit                   |    84 |

## Source and proof identities

- development snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`;
- calendar: `alpaca-us-equity-calendar-v1`;
- both physical ClickHouse replicas: 1,762 rows and 1,762 distinct dates, first `2016-01-04`, last `2022-12-30`;
- byte-identical bounded ordered session export on both replicas: 454,596 bytes, SHA-256
  `9b3a4058fe6f911549083ad397fcc3512798385d4046d92c5150f0562e4a34f5`;
- policy source SHA-256: `71056ad99b219430756cd674298e0b5c1a245c94be09ccd0ff76d602dd08e990`;
- walk-forward implementation SHA-256: `921940ebf72aebd5f6cae14457d6e4c868c681bebc42562b2d2965fb879da3e6`;
- pure geometry proof commit: `78c485444fc11a1a148c2aeb5fc6a050497a9f61`;
- pure geometry source SHA-256: `b095150dbb1ffad0ebb3c92e6b8ea1267619aed72a5502eb367f9d8fd6b0af51`;
- focused test SHA-256: `b7a5878ac79fe534084244bf7ae8356801ae7e372bbd25161d3cad5b07dfddbf`.

At the proof commit, three focused tests passed: the exact 63-return monthly design is infeasible, the raw zero-lookback
upper bound is infeasible, and malformed geometry inputs fail closed. TypeScript, Oxfmt, staged Oxlint, and
`git diff --check` also passed.

## Fail-closed disposition

Candidate 8 was rejected at the required pre-registration feasibility gate. The research implementation and tests were
removed after preserving their exact commit and content hashes above. No strategy module, production export,
preregistration, development report, JSON artifact, qualification wiring, image, GitOps change, broker mutation, capital
authority, or OBSERVE runtime change remains in the final tree.

The only data query beyond repository source was the bounded official-session calendar through `2022-12-30`. No adjusted
bar, return, weight, benchmark metric, bootstrap result, or power result was computed. The untouched holdout
`2023-01-03` through `2025-12-31` was not queried, inspected, summarized, or evaluated.
