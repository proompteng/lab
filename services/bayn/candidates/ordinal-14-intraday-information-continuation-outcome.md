# Candidate ordinal 14: intraday-information continuation development outcome

Status: **HOLD_REJECT — development attempt consumed; executable code removed; holdout untouched**

Candidate 14 completed its sole preregistered development evaluation exactly once. The v2 contract, ordered signal
path, and fixed requested/filled quantity path all conformed. The candidate is rejected because it failed benchmark
Sharpe improvement and both adjusted uncertainty lower-bound gates. It provides no evidence of benchmark-relative
profitability and authorizes no holdout access, merge, deployment, capital, broker, authority, or order action.

## Immutable ancestry and identities

- Fresh base: `e0d6f23814df4749f6c9432d6b53d5f8c9e00f80`.
- Protocol source revision: `ad9a7477d645b4644c83384158783b2083fc7f88`.
- Deployed protocol digest:
  `sha256:ad8c84a312bcf66cc998029b91f13e4e785f50e30351396e69a1b0f68183e881`.
- Preregistration commit: `48a797c314799ea8315bb12fc743566ecaedc62c`.
- Preregistration SHA-256: `d25b2a4f547d0460f04a6e0990cb8fc1284981947122065c29da2ad4df473ea5`.
- Evaluated implementation commit: `86c7d68e7d675dd83d7d0a5b0576f3fbf48249f6`.
- Candidate ordinal / prior trial count: `14` / `13`.
- Parameter hash: `6258d0497293022058879479da3921b56a99cd1bec914a1f6072eb3e5ae0357a`.
- Behavior hash: `d35c6aba9d6d9ee17d561aa72df41b1c3b0cb65b85046c57fca7c54d11a6d555`.
- Family strategy hash: `57246344ad61213293e83f7225989b38c027d217c2f162e3aa1241033d9bc1c8`.
- Family run ID: `cc3ec71d86e90308697c7ca58598d0b7cef50553fcc9d4576159da6c42e7b066`.
- Specification strategy hash: `33d9be7469a5ded142fe5788686c537be5c0b40f20d3591611f6e023e9dd716c`.
- Specification run ID: `0b3877e6ab74e325c45f9ec407087bfd86afa165a923ae93b3c895b96fa0195e`.
- Report hash: `47e6ee04c0f2c401c95d5d7cf0637ca91a8bb73b89eecb9b9587f8f673702866`.
- Analysis hash: `1692a34de39508d2ceb4e0ccd2ef5b15d64abd8ed648eeb98ffdfa48fe3b63be`.

## Frozen data identity

- Snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Bounds: `2016-01-04..2022-12-30`.
- Ordered universe: `DBC,EFA,IEF,SPY,VNQ`.
- Sessions / bars: `1762` / `8810`.
- Sessions content hash: `a93ca33808e23588753ebb9b8d64fd06a034e6a969a9191a43fac667b8472eb8`.
- Bars content hash: `b4359ebbc1b56c9bf05a4e6cb64205937ab2845cbd2d7022161f52009309d482`.
- Query disposition: one read-only bounded query; no alternate snapshot, data repair, sweep, or rerun.

## V2 preflight and multiplicity

- Status: `PASS`.
- Protocol identity hash: `667a7f11b5fd317e20033457b6faa9225a52fe78d3fb40c271dfe72811d191fc`.
- Feature lookback: `126` sessions.
- Required / available observations: `1489` / `1617`.
- Unused eligible observations: `128`.
- Selected window: `2017-02-02..2022-12-30`.
- Bootstrap samples: `10000`.
- Adjusted one-sided alpha: `0.0035714285714285718`.
- Nearest-rank lower-tail sample count: `35`; minimum `20`.
- Family specification count / multiplicity divisor: `1` / `1`.
- Selected specification: `null`; no specification passed every gate.

| Fold | Training start | Training end | Training observations | Test start   | Test end     | Test observations |
| ---: | -------------- | ------------ | --------------------: | ------------ | ------------ | ----------------: |
|    0 | `2017-02-02`   | `2019-02-04` |                   504 | `2019-02-05` | `2019-11-13` |               197 |
|    1 | `2017-02-02`   | `2019-11-13` |                   701 | `2019-11-14` | `2020-08-26` |               197 |
|    2 | `2017-02-02`   | `2020-08-26` |                   898 | `2020-08-27` | `2021-06-09` |               197 |
|    3 | `2017-02-02`   | `2021-06-09` |                  1095 | `2021-06-10` | `2022-03-21` |               197 |
|    4 | `2017-02-02`   | `2022-03-21` |                  1292 | `2022-03-22` | `2022-12-30` |               197 |

## Frozen specification

- ID: `intraday-relative-126-exposure90`.
- Lookback: `126` sessions.
- Selected-symbol weight / cash reserve: `0.9` / `0.1`.
- Minimum relative intraday return: `0`.
- Selected stronger benchmark: `buy-and-hold`.
- Final development status: `HOLD_REJECT`; `developmentPass=false`.

## Every emitted performance metric

| Path                             | Metric                       |            Exact value |
| -------------------------------- | ---------------------------- | ---------------------: |
| Candidate baseline               | Observations                 |                 `1489` |
| Candidate baseline               | Total return                 |   `0.5147256506729998` |
| Candidate baseline               | Annualized return            |  `0.07280285689914279` |
| Candidate baseline               | Annualized volatility        |  `0.16405117524988608` |
| Candidate baseline               | Sharpe                       |   `0.5114865035996572` |
| Candidate baseline               | Maximum drawdown             |  `0.31661098934658605` |
| Candidate baseline               | Annual turnover              |   `7.0467044219394825` |
| Candidate baseline               | Total fees micros            |            `528730000` |
| Candidate baseline               | Total spread cost micros     |          `10471102016` |
| Candidate baseline               | Total slippage cost micros   |          `10392710926` |
| Candidate baseline               | Total cash yield micros      |                    `0` |
| Candidate baseline               | Ending equity micros         |        `1514725650673` |
| SPY buy-and-hold                 | Observations                 |                 `1489` |
| SPY buy-and-hold                 | Total return                 |   `0.9564558422860001` |
| SPY buy-and-hold                 | Annualized return            |  `0.12028549341279238` |
| SPY buy-and-hold                 | Annualized volatility        |  `0.19735272913254676` |
| SPY buy-and-hold                 | Sharpe                       |   `0.6747749138384274` |
| SPY buy-and-hold                 | Maximum drawdown             |   `0.3379380082003881` |
| SPY buy-and-hold                 | Annual turnover              |   `0.5003605389313257` |
| SPY buy-and-hold                 | Total fees micros            |             `41400000` |
| SPY buy-and-hold                 | Total spread cost micros     |            `739552792` |
| SPY buy-and-hold                 | Total slippage cost micros   |            `739552792` |
| SPY buy-and-hold                 | Total cash yield micros      |                    `0` |
| SPY buy-and-hold                 | Ending equity micros         |        `1956455842286` |
| Direct 10% volatility            | Observations                 |                 `1489` |
| Direct 10% volatility            | Total return                 |  `0.49634369945900003` |
| Direct 10% volatility            | Annualized return            |  `0.07058831769576224` |
| Direct 10% volatility            | Annualized volatility        |  `0.12266480011703954` |
| Direct 10% volatility            | Sharpe                       |   `0.6176803433836434` |
| Direct 10% volatility            | Maximum drawdown             |   `0.2546190102462126` |
| Direct 10% volatility            | Annual turnover              |   `1.6485606424484969` |
| Direct 10% volatility            | Total fees micros            |            `109910000` |
| Direct 10% volatility            | Total spread cost micros     |           `2437083837` |
| Direct 10% volatility            | Total slippage cost micros   |           `2435284811` |
| Direct 10% volatility            | Total cash yield micros      |                    `0` |
| Direct 10% volatility            | Ending equity micros         |        `1496343699459` |
| Candidate fixed-quantity 2x cost | Observations                 |                 `1489` |
| Candidate fixed-quantity 2x cost | Total return                 |  `0.49337538753099985` |
| Candidate fixed-quantity 2x cost | Annualized return            |   `0.0702285976314001` |
| Candidate fixed-quantity 2x cost | Annualized volatility        |  `0.16552717122288105` |
| Candidate fixed-quantity 2x cost | Sharpe                       |   `0.4939084125806508` |
| Candidate fixed-quantity 2x cost | Maximum drawdown             |  `0.32241482491632456` |
| Candidate fixed-quantity 2x cost | Annual turnover              |    `7.046659088002276` |
| Candidate fixed-quantity 2x cost | Total fees micros            |           `1056010000` |
| Candidate fixed-quantity 2x cost | Total spread cost micros     |          `20863812944` |
| Candidate fixed-quantity 2x cost | Total slippage cost micros   |          `20822983143` |
| Candidate fixed-quantity 2x cost | Total cash yield micros      |                    `0` |
| Candidate fixed-quantity 2x cost | Ending equity micros         |        `1493375387531` |
| Candidate vs stronger benchmark  | Annualized return difference | `-0.04748263651364959` |
| Candidate vs stronger benchmark  | Sharpe difference            | `-0.16328841023877017` |

The candidate's point annualized return was 7.2802856899% and Sharpe was
0.5114865036, versus SPY buy-and-hold at 12.0285493413% and
0.6747749138. The conforming fixed-quantity 2x-cost path remained positive at
7.0228597631% annualized return.

## Point-economic gates

Economic verdict: `FAIL_CLOSED`.

| Gate                           | Passed  | Actual                 | Required |
| ------------------------------ | ------- | ---------------------- | -------- |
| `finite_metrics`               | `true`  | `True`                 | `True`   |
| `minimum_observations`         | `true`  | `1489`                 | `504`    |
| `positive_net_return`          | `true`  | `0.07280285689914279`  | `>0`     |
| `benchmark_sharpe_improvement` | `false` | `-0.16328841023877017` | `>0`     |
| `maximum_drawdown`             | `true`  | `0.31661098934658605`  | `<=0.35` |
| `maximum_turnover`             | `true`  | `7.0467044219394825`   | `<=12`   |
| `double_cost_return`           | `true`  | `0.0702285976314001`   | `>0`     |

## Doubled-cost v2 causal evidence

- Status: `PASS`.
- Schema: `bayn.candidate-development-doubled-cost-check.v1`.
- Signal decisions hash: `e8fd6dc36de625ae6ef6acefab0adcb93005a17533a4d5f27124b8bac6225478`.
- Ordered requested/filled quantity-path hash: `860b90c4185896ab236a5f4aa8a758d5ae3d402aeec16f60d905f07ae9645a0a`.
- Execution-model hash: `5e8fa97162f0f5818e50c78ccb66be235a19b391ba21880fac442663a69de2f4`.
- Signal and quantity paths were invariant; stressed cash never became negative.

| Terminal path        | All cash |
| -------------------- | -------- |
| `strategy`           | `true`   |
| `buyAndHold`         | `true`   |
| `directVolatility`   | `true`   |
| `doubleCostStrategy` | `true`   |

## Adjusted uncertainty and power evidence

- Status: `REJECTED`.
- Reason codes: `NON_POSITIVE_EXCESS_RETURN_LCB, NON_POSITIVE_SHARPE_DIFFERENCE_LCB`.
- Adjusted one-sided alpha: `0.0035714285714285718`.
- Produced bootstrap samples: `10000`.
- Bootstrap samples hash: `67936c00d0bf11183ce96fb0f45470d3256f701c7958177f426b0a7a581a1b81`.
- Annualized excess-return lower confidence bound: `-0.060310059432`.
- Sharpe-difference lower confidence bound: `-0.941577984768`.
- Complete rebalance blocks: `70`; required
  `69`.
- Available complete sessions: `1470`; required
  `1449`.
- Positive walk-forward folds: `3` of 5; required at least 3.

| Fold | Training start | Training end | Test start   | Test end     | Observations |     Excess return | Maximum drawdown | Positive excess |
| ---: | -------------- | ------------ | ------------ | ------------ | -----------: | ----------------: | ---------------: | --------------- |
|    0 | `2017-02-02`   | `2019-02-04` | `2019-02-05` | `2019-11-13` |          197 |  `0.007594453216` | `0.066680341103` | `true`          |
|    1 | `2017-02-02`   | `2019-11-13` | `2019-11-14` | `2020-08-26` |          197 |  `0.052070123914` | `0.251205840578` | `true`          |
|    2 | `2017-02-02`   | `2020-08-26` | `2020-08-27` | `2021-06-09` |          197 |  `0.406190892869` | `0.085609168211` | `true`          |
|    3 | `2017-02-02`   | `2021-06-09` | `2021-06-10` | `2022-03-21` |          197 | `-0.007230339686` | `0.153454861756` | `false`         |
|    4 | `2017-02-02`   | `2022-03-21` | `2022-03-22` | `2022-12-30` |          197 | `-0.079002503857` | `0.221167822554` | `false`         |

The walk-forward count and drawdown gates passed, but the adjusted lower bounds were materially below zero. The final two
folds also had negative excess return. No statistical or economic override is permitted.

## Terminal disposition and mutation audit

- Development outcome: `HOLD_REJECT`.
- Attempt consumed: `true`; metric-bearing evaluation count: `1`.
- Sweep / retune / alternate seed / rerun / family substitution: `false`.
- Holdout: `inspected=false`, `accessCount=0`, exact bounds `2023-01-03..2025-12-31`.
- Broker access, capital, orders, database writes, runtime composition, manifests, GitOps, deployment, and authority
  mutation: `0`.
- Final branch disposition: retain this preregistration and outcome Markdown only; remove all executable Candidate 14
  source, tests, CLI, and package script; publish an evidence PR and close it unmerged.
