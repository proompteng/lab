# Bayn Candidate 9 development rejection

Status: `HOLD_REJECT`

Candidate ordinal: `9`

Strategy: `asymmetric-range-volatility-managed-equity`

Decision: reject the family after its single metric-bearing development evaluation. Do not access the terminal holdout,
qualify the candidate, switch the deployed strategy, enable broker orders, or advance capital.

## Immutable identity

- Preregistration commit: `4984471551f4758950445a02e179b8920bf9e153`
- Preregistration SHA-256: `6a8029d7638eecdd103bb8d0ee558772ff8797e72b93c1371947c28836e508c4`
- Evaluated executable commit: `d6e8aff25ecf679f62b3eec06545824c4c1d336a`
- Parameter hash: `cd5897200f3efd37dd61bcd6d7268b233d8c199c66b86ceea110dfad5af208c7`
- Behavior hash: `bc13a002d047f60b764ae2f11f33e484401a484bc2e5edc50e0a9c29b4c557ef`
- Strategy hash: `05bf295c35eb0a0223e7f81c82a778afdcfbd0237e2e3a4cc0268aec9856f8ed`
- Development run ID: `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`
- Canonical report hash: `5d1e9f2ad481343e9b745893807300c3b18b3162dcc4853732132256e63251c9`
- Captured report-file SHA-256: `1abc749a3faba0853200a30e387ba5916525872b16782a6bd68e917782af68dc`

One earlier command invocation at commit `dead1ada0e920978037d43303eefd83c17a253bd` failed before producing a
report or metrics because the ClickHouse calendar predicate compared `String` and `Date`. The corrected command
materialized the bounded calendar before the first return-data query. The strategy, symbols, dates, estimator,
allocation, execution model, benchmarks, multiplicity, and gates did not change.

## Frozen data and geometry

- Snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`
- Sessions: exactly 1,762 from `2016-01-04` through `2022-12-30`
- Bars: exactly 1,762 adjusted SIP `SPY` daily OHLCV rows
- Sessions content hash: `d748da758a814ca98068e830f49b4f8eda9db183566b325a8ac5fcdb8c40f8a8`
- Bars content hash: `e41d672620e8f1947364d09de14dedb370b6c91d65dc300d4c7d0143abc32913`
- Selected development observations: 1,489, indices 273 through 1,761, `2017-02-02` through `2022-12-30`
- Walk-forward: 504 initial training sessions plus five chronological, non-overlapping 197-session test folds
- Complete rebalance blocks: 70; required: 69
- Complete sessions: 1,470; required: 1,449
- Bootstrap: 5,000 non-wrapping paired complete-block samples
- Selection penalty: Bonferroni one-sided alpha `0.05 / 9 = 0.005555555555555556`

## Net modeled results

| Measure               |          Candidate 9 |    SPY buy-and-hold | Direct-volatility benchmark | Candidate 9 at double cost |
| --------------------- | -------------------: | ------------------: | --------------------------: | -------------------------: |
| Total return          |  0.20146580568000005 |       0.42417458439 |         0.35080771337500005 |        0.19013523178600011 |
| Annualized return     | 0.031550390214707846 | 0.06166918073175709 |         0.05220846937218515 |        0.02989749799943464 |
| Annualized volatility |  0.08125485479775894 | 0.11655015966275686 |            0.12009879779575 |        0.08123964704610916 |
| Sharpe                |  0.42314301757284367 |   0.571935591653402 |         0.48414574103129354 |         0.4034655902480108 |
| Maximum drawdown      |  0.11727922352993947 | 0.20604279983940166 |         0.25461900260311265 |        0.11989081959429682 |
| Annual turnover       |    3.630531852605738 | 0.24069697531417594 |          1.4813731276318953 |          3.612994983573921 |

The selected stronger benchmark was SPY buy-and-hold. Candidate 9's benchmark-relative annualized return was
`-0.030118790517049243`, and its Sharpe difference was `-0.14879257408055835`.

Candidate 9 incurred exact modeled costs of `231320000` fee micros, `5366966177` half-spread micros, and
`5362543364` slippage micros. Its double-cost simulation remained positive. Every terminal liquidation seed resolved
as a complete fill, so candidate and benchmark simulations ended in cash inside the development boundary.

## Uncertainty and chronological stability

The uncertainty verdict was `REJECTED`:

- Annualized excess-return lower bound: `-0.045937553209`
- Sharpe-difference lower bound: `-0.994314336731`
- Bootstrap samples hash: `d85a5c95a6b2f1fb6c71770e81da1dfd18fb6af3928f3b0bc73dc8cfe3d70c29`
- Analysis hash: `ee4393be91e17b19aaffadac03a299af6ecf035707e3c51afbd94607943caa6a`
- Reason codes: `NON_POSITIVE_EXCESS_RETURN_LCB`, `NON_POSITIVE_SHARPE_DIFFERENCE_LCB`

| Fold | Test interval                     | Cash-relative return | Maximum drawdown | Positive |
| ---: | --------------------------------- | -------------------: | ---------------: | -------- |
|    0 | `2019-02-05` through `2019-11-13` |       0.005220937981 |   0.089382252649 | yes      |
|    1 | `2019-11-14` through `2020-08-26` |       0.034107082172 |   0.071687296993 | yes      |
|    2 | `2020-08-27` through `2021-06-09` |       0.022226697582 |   0.094909958848 | yes      |
|    3 | `2021-06-10` through `2022-03-21` |       0.020614844683 |   0.049155144188 | yes      |
|    4 | `2022-03-22` through `2022-12-30` |      -0.026904387183 |   0.035935068491 | no       |

The family passed its net-return, drawdown, turnover, double-cost, power, and 4-of-5 fold-stability gates. It failed
because the stronger benchmark had materially higher annualized return and Sharpe, and both selection-adjusted lower
confidence bounds were below zero. No specification passed development, so the family is terminally rejected without
holdout access.

## Holdout and authority

- Holdout interval: `2023-01-03` through `2025-12-31`
- Holdout inspected: `false`
- Holdout access count: `0`
- Official terminal qualification trials consumed: `0`
- Broker mutations: `0`
- Production strategy changes: `0`
- Capital-authority changes: `0`
