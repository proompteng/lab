# Bayn Candidate 17 preregistration: volatility-managed trend overlay

Status: **HASH-PREREGISTERED FOR DEVELOPMENT SOURCE REVIEW — executable blob intentionally absent**

This revision freezes one exact Candidate 17 artifact hash before that executable blob is committed to Git. The source
manifest, executable module, verifier fixtures, tests, and calendar authorization must appear only in a proper descendant
revision. The descendant must contain the exact future module blob identified below; any changed byte is a different,
unauthorized candidate.

No qualification holdout row was requested or inspected. No qualification attempt, broker binding, PAPER activation,
order submission, authority transition, credential change, or GitOps mutation is authorized by this record.

## Immutable identity and two-stage ancestry

- Candidate ordinal / prior consumed trials: `17` / `16`.
- Fresh source base: `e0a38e65e7ba65fb7d00585b02d9fc2cdbeee826`.
- Strategy: `volatility-managed-trend-overlay` version `1.0.0`.
- Future module path:
  `services/bayn/src/strategy/volatility-managed-trend-overlay/candidate-17.ts`.
- Future module SHA-256:
  `2e98bc55eae1901ccdde41978b7b32d746dc2ef6afcebbff1de0ed54574065da`.
- Future Git blob OID: `8d1ccbfc6bef2c1707ac85f51d1647a7a8bfd98b`.
- Canonical specification hash:
  `a9f17869ac3f5c516e1b920c21a2f685f29d3bfba0fb90f10fa081e19a7ce86c`.
- Strategy-protocol hash:
  `fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390`.
- Machine preregistration:
  `services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json`.

This preregistration revision must not contain the future module blob anywhere in its reachable history. The evaluated
source revision must be a proper descendant, and its module SHA-256 must equal the frozen value above. The calendar may
reference this preregistration only from that descendant.

## Research basis and falsifiable economic hypothesis

Primary sources:

- AQR, “A Century of Evidence on Trend-Following Investing”:
  https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing
- AQR, “Time-Series Momentum: Original Paper Data”:
  https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Original-Paper-Data
- Alan Moreira and Tyler Muir, “Volatility-Managed Portfolios,” NBER Working Paper 22208:
  https://www.nber.org/system/files/working_papers/w22208/w22208.pdf

Bayn does not claim that these papers specify or validate this ETF implementation. Candidate 17 tests one fixed
interaction: preserve broad equity participation with a `0.70` SPY core, then allocate at most `0.295` to non-SPY assets
whose own 252-session total return is positive, with the active basket scaled inversely to its causal 21-session realized
variance toward a `0.10` annualized volatility target. At least `0.005` remains as a financing reserve. The hypothesis is
falsified if the fixed post-cost evidence does not beat the governed benchmark after ordinal-adjusted inference.

This is economically distinct from Candidate 5, which allocated the full portfolio using multi-horizon trend conviction
and individual volatility risk balancing, and Candidate 9, which timed SPY itself using a SPY range-volatility forecast.
Candidate 17 never removes or volatility-times the fixed SPY core, performs no cross-sectional ranking, and manages only
the separate active basket.

## Frozen data and causal schedule

- Universe in code-unit order: `DBC,EFA,IEF,SPY,VNQ`.
- Active universe: `DBC,EFA,IEF,VNQ`; SPY is the fixed core only.
- Finalized snapshot:
  `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Finalized snapshot content hash:
  `8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d`.
- Bounded input-manifest hash:
  `b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4`.
- Bounded market-data witness hash:
  `e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed`.
- Development interval: `2016-01-04..2022-12-30`, 1,762 official sessions and 8,810 adjusted OHLCV rows.
- Qualification holdout remains untouched: `2023-01-03..2025-12-31`.
- Signal: finalized official month-end close using only observations ending at that close.
- Execution: immediately following official session open.
- First eligible execution: `2017-02-01` from the `2017-01-31` signal.
- Selected evidence window: `2017-02-02..2022-12-30`.
- Terminal policy: all cash after the `2022-11-30` signal / `2022-12-01` execution.

Future bars, the execution-session open, intraday observations, later broker state, and holdout rows cannot affect a
signal. The strategy is long-only and unlevered.

## Costs, benchmarks, and inference

The exact `bayn.execution-model.v2` contract is embedded in the future executable. Baseline costs use multiplier
`1000000`; doubled-cost stress uses `2000000` and must preserve the ordered signal and requested/filled quantity path.
Any divergence is terminal `INVALID_PROTOCOL_DEVIATION` evidence.

The governed benchmark is the stronger cash-adjusted Sharpe result between SPY buy-and-hold and the existing 63-session,
10%-target-volatility SPY rule. Evidence uses five latest-contiguous expanding-origin folds, 504 minimum training
sessions, 197 test sessions per fold, 10,000 complete non-wrapping rebalance-block bootstrap samples, Candidate-17
Bonferroni adjustment, at least 20 lower-tail samples, positive return and Sharpe-difference lower bounds, at least 60%
positive folds, drawdown no greater than 35%, positive doubled-cost return, and terminal cash on both cost paths.

## Preserved development-only dry-run evidence

The exact offline artifact identified by the frozen SHA-256 was executed during construction solely against the bounded
2016–2022 development witness. This disclosure is included to avoid implying unobserved profitability; it grants no
additional run or authority.

- Selected observations: 1,489.
- Governed decisions: 70.
- Bootstrap lower-tail samples: 29.
- Walk-forward folds: 5.
- Baseline annualized return: `0.088470`.
- SPY buy-and-hold annualized return: `0.121446`.
- Doubled-cost annualized return: `0.087895`.
- Annualized-return-difference lower bound: `-0.089139`.
- Sharpe-difference lower bound: `-0.1910`.
- Baseline and doubled-cost paths terminate in cash.

The development evidence is economically weak relative to buy-and-hold and is not a PASS or qualification claim. The
artifact remains fail-closed and dormant until the separate governed command consumes the one authorized development
attempt. No post-metric parameter search, alternate window, reseed, family substitution, or repair is permitted.
