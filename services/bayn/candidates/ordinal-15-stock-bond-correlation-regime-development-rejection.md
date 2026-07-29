# Candidate ordinal 15: stock-bond-correlation regime development rejection

Status: **HOLD_REJECT — one valid v2 development attempt consumed**

Candidate 15 does not provide evidence of a genuinely qualified profitable strategy. Its fixed stock-bond-correlation
regime rule passed every mechanical point-estimate economic gate and produced a higher point Sharpe than the mechanically
stronger benchmark, but both Candidate-15-adjusted lower confidence bounds were negative. No retune, rerun, alternate
seed, family substitution, holdout access, or capital action is authorized.

## Terminal disposition

- Candidate ordinal: `15`.
- Prior trial count: `14`.
- Frozen family: `stock-bond-correlation-regime-allocation`.
- Frozen specification: `spy-ief-correlation-126-spy45-hedge45-reserve10`.
- Sole metric-bearing development evaluation started at `2026-07-29T23:32:52Z` and finished at
  `2026-07-29T23:32:59Z`.
- Command exit: `2`, the expected CLI disposition for a conforming `HOLD_REJECT` report.
- No application error was emitted. Standard error contained only the `kubectl exec` wrapper's
  `command terminated with exit code 2` message.
- The attempt is consumed. The result must not be rerun, retuned, repaired, reseeded, reframed, or replaced by another
  specification in this family.
- `developmentPass=false`; `selectedSpecificationId=null`.
- Terminal status: `HOLD_REJECT`, not `INVALID_PROTOCOL_DEVIATION`.

The sole report bytes were retained outside the repository for audit during this task but are deliberately not committed
as a JSON evidence dump.

## Immutable ancestry and executable identity

- Fresh base: `66a973a11ed3c46a25624c324705136e8fb72233`.
- Immutable preregistration commit: `9aac01753a332aeeeac2bc20d7536eeb45d74a51`.
- Immutable preregistration SHA-256:
  `e11ad74f8f4d8ab8e9c57528fe021b809190a9b0e56c5c01c55e25cf3f527828`.
- Evaluated implementation commit: `4c511bdad0593e23cb07de2dbf9be8360c56a337`.
- Evaluated command SHA-256: `1ff3ee4b5fdf80ce1666f450cd89930c69e4e64c8ca26e873fdca833259d6097`.
- Evaluated strategy SHA-256: `29540a392796e1f9ab9c8441f6ad120453c83f6be12c7dec4e00ddec074d8b35`.
- Evaluated model SHA-256: `7708abd1ef2fcff2078a660387a31b269a997462e6774a26a7d48b8836bdcd85`.
- Evaluated development/replay SHA-256:
  `660ae36cde011920b63c4af0844aa56ac715e0de002c5cd8f5b7b4d66e5a2a58`.
- Evaluated synthetic tests SHA-256:
  `93d2c6afeebcc3b98a869b8da098ceac78abb7e5594b743e98cee4ddf94bdecf`.
- Evaluated package manifest SHA-256:
  `f0bc310e4980bbbe315551136d30c1c43438e40167a4bbdb1a0461f2afedf3fb`.
- Exact evaluated Node bundle SHA-256:
  `e5d844aafc9870a699e91c68f0ff9f3b9012c0c6a6ca0454ac1787e08c0a2478`.
- Temporary streamed runtime bundle SHA-256:
  `30743a0dc0b78b8237ebfa6a4af5d5698ebe48d9e3d9d6f5af2ac5c64d33c169`.
  The only difference from the evaluated bundle was injection of the immutable preregistration bytes and exact evaluated
  commit into the CLI environment; no strategy, simulation, benchmark, cost, statistical, or gate behavior changed.
- Sole report-output SHA-256:
  `d52d8d267a3742a56e7586beed56130bf40cbffbf26e37bb5c1f414d05ccc424`.
- One-shot metadata SHA-256:
  `37da288a6ddcd5bdbfdf84dab1270e3d21c7810b2a2934a86d4050745cd3bff2`.

Git ancestry was explicitly verified as:

```text
66a973a11ed3c46a25624c324705136e8fb72233
  -> 9aac01753a332aeeeac2bc20d7536eeb45d74a51
  -> 4c511bdad0593e23cb07de2dbf9be8360c56a337
```

## Canonical report and family identities

| Identity                       | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| Candidate-development protocol | `4de2942be5edfd28618d338fb01046dd7046e0eb471d32a07ac107d5c5ed5409` |
| Parameter                      | `856d731795849781b9f824a3b7fdf2f535262cd96144b1aabc7c60f84726a288` |
| Behavior                       | `f125b14022360895525c8941310b430236451229dff85214d9251b22d8ebced2` |
| Family strategy                | `4e294049f5f90d9373c0aaff38187dc6bf358928b9dbff041dd53f4e8d228695` |
| Family run                     | `e8e273266688c8907031d2a919230bf2da6fef25615aa2e2403ee33226b25549` |
| Specification strategy         | `e2a397e35a7b583513671ed84a2058d5074f5af4e0cf2441d97abf5d3533272d` |
| Specification run              | `01072fb403c91e1938492556507c2585444c9c7b01aa5a9b68781ddac97464a9` |
| Canonical report               | `f4252f5d3ffb20d361b2f6f64b8a59b7b366d964fd3395ccb47df85292fd1514` |
| Qualification analysis         | `2d4ca2a681737170f4a2da6968f507116ca9807ffb075e6f45547f4f4903bc70` |
| Bootstrap samples              | `cf2926255344a3753fc149a87490c4c12d47c4c5107d7936ef15a062cc3d0d13` |

The family run identity above is Candidate 15's consumed attempt identity for future lineage accounting.

## Bounded development data identity

- Snapshot ID: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Table: `signal.adjusted_daily_bars_v2`.
- Requested and observed bounds: `2016-01-04` through `2022-12-30`, inclusive.
- Ordered universe: `DBC,EFA,IEF,SPY,VNQ`.
- Sessions: `1,762`.
- Bars: `8,810`.
- First session: `2016-01-04`.
- Last session: `2022-12-30`.
- Sessions content hash: `7d5cecf96869d5145cbb0568ca761a1060c4261876bb75db889e7f0736f6c0e3`.
- Bars content hash: `4baea2a1a8aa22aa04203ba77d638dd5a5fe761f88e83bdf59b2c514d33f7b0d`.
- The ClickHouse client was configured `readonly=1`; the only data operation was the one preregistered bounded `SELECT`.

## V2 attempt and walk-forward geometry

Preflight status was `PASS` before the development-data effect ran.

- Protocol schema: `bayn.candidate-development-preflight.v2`.
- Candidate ordinal / prior trial count: `15 / 14`.
- Bootstrap samples: `10,000`.
- Candidate-adjusted one-sided alpha: `0.0033333333333333335` (`0.05 / 15`).
- Adjusted nearest-rank lower-tail sample count: `33`.
- Minimum lower-tail sample count: `20`.
- Maximum permitted candidate ordinal: `25`.
- Feature lookback: `126` return sessions.
- First eligible signal: index `144`, `2016-07-29`.
- First eligible next-open execution: index `145`, `2016-08-01`.
- Available observations after first execution: `1,617`.
- Required selected observations: `1,489`.
- Unused earlier eligible observations: `128`.
- Selected interval: indices `273..1761`, `2017-02-02..2022-12-30`.
- Available / required fold count: `5 / 5`.

| Fold | Training indices | Training dates           | Training observations | Test indices | Test dates               | Test observations |
| ---: | ---------------- | ------------------------ | --------------------: | ------------ | ------------------------ | ----------------: |
|    0 | `273..776`       | `2017-02-02..2019-02-04` |                   504 | `777..973`   | `2019-02-05..2019-11-13` |               197 |
|    1 | `273..973`       | `2017-02-02..2019-11-13` |                   701 | `974..1170`  | `2019-11-14..2020-08-26` |               197 |
|    2 | `273..1170`      | `2017-02-02..2020-08-26` |                   898 | `1171..1367` | `2020-08-27..2021-06-09` |               197 |
|    3 | `273..1367`      | `2017-02-02..2021-06-09` |                 1,095 | `1368..1564` | `2021-06-10..2022-03-21` |               197 |
|    4 | `273..1564`      | `2017-02-02..2022-03-21` |                 1,292 | `1565..1761` | `2022-03-22..2022-12-30` |               197 |

The emitted statistics policy was unchanged: 252-session annualization; Bonferroni family alpha `0.05`; minimum tail
count `20`; 10,000 paired complete-rebalance-block bootstrap samples using seed namespace
`bayn-risk-balanced-trend-qualification-v1` and nearest-rank lower quantiles; 3% annualized minimum detectable excess
return at 10% assumed tracking volatility and 80% target power; absolute minima of 504 sessions and 24 blocks; expanding
origin with five 197-session tests, at least 60% positive folds, and maximum fold drawdown 35%; actual/365 simple cash
return.

## Complete emitted performance metrics

All monetary accounting values below are integer micros exactly as emitted.

| Path                                  | Observations |          Total return |     Annualized return | Annualized volatility |               Sharpe |      Maximum drawdown |      Annual turnover | Fees micros | Spread micros | Slippage micros | Cash yield micros | Ending equity micros |
| ------------------------------------- | -----------: | --------------------: | --------------------: | --------------------: | -------------------: | --------------------: | -------------------: | ----------: | ------------: | --------------: | ----------------: | -------------------: |
| Candidate baseline                    |        1,489 |      `0.442354810276` | `0.06395078328982295` |  `0.0928972185318922` | `0.7138675273680499` | `0.16934346917238097` | `1.3206578844455177` | `105200000` |  `1964290450` |    `1949508614` |               `0` |      `1442354810276` |
| SPY buy-and-hold                      |        1,489 |  `0.9564558422860001` | `0.12028549341279238` | `0.19735272913254676` | `0.6747749138384274` |  `0.3379380082003881` | `0.5003605389313257` |  `41400000` |   `739552792` |     `739552792` |               `0` |      `1956455842286` |
| Direct SPY 10% volatility             |        1,489 | `0.49634369945900003` | `0.07058831769576224` | `0.12266480011703954` | `0.6176803433836434` |  `0.2546190102462126` | `1.6485606424484969` | `109910000` |  `2437083837` |    `2435284811` |               `0` |      `1496343699459` |
| Candidate invariant-quantity 2x costs |        1,489 |  `0.4383518284000001` |  `0.0634504722154523` | `0.09301197390879026` | `0.7080434696707374` | `0.17008177650697387` | `1.3206202065668502` | `208800000` |  `3913799069` |    `3899381881` |               `0` |      `1438351828400` |

SPY buy-and-hold was mechanically selected as the stronger benchmark because its point Sharpe
`0.6747749138384274` exceeded direct-volatility timing's `0.6176803433836434`. Against that selected benchmark:

- Candidate annualized-return difference: `-0.05633471012296942`.
- Candidate Sharpe difference: `0.039092613529622566`.

The candidate therefore produced a modestly higher point Sharpe but materially lower annualized return than SPY. Point
estimates alone do not satisfy the v2 uncertainty contract.

## Every mechanical economic gate

The mechanical economic verdict was `PASS` before uncertainty gates were applied.

| Gate                           | Passed | Actual                 | Required |
| ------------------------------ | ------ | ---------------------- | -------- |
| `finite_metrics`               | true   | `true`                 | `true`   |
| `minimum_observations`         | true   | `1489`                 | `504`    |
| `positive_net_return`          | true   | `0.06395078328982295`  | `>0`     |
| `benchmark_sharpe_improvement` | true   | `0.039092613529622566` | `>0`     |
| `maximum_drawdown`             | true   | `0.16934346917238097`  | `<=0.35` |
| `maximum_turnover`             | true   | `1.3206578844455177`   | `<=12`   |
| `double_cost_return`           | true   | `0.0634504722154523`   | `>0`     |

## Multiplicity-adjusted uncertainty and power result

Uncertainty status: **REJECTED**.

Reason codes:

- `NON_POSITIVE_EXCESS_RETURN_LCB`
- `NON_POSITIVE_SHARPE_DIFFERENCE_LCB`

Complete uncertainty output:

- Adjusted one-sided alpha: `0.0033333333333333335`.
- Produced bootstrap samples: `10,000`.
- Annualized excess-return lower confidence bound: `-0.03248474065`.
- Sharpe-difference lower confidence bound: `-0.360771458451`.
- Complete non-wrapping rebalance blocks: `70`; required: `69`.
- Available complete sessions: `1,470`; required: `1,449`.
- Positive walk-forward folds: `4 / 5`; required fraction: at least `0.6`.
- Every fold drawdown was below the frozen `0.35` ceiling.

| Fold | Training dates           | Test dates               | Test observations | Benchmark excess return | Maximum drawdown | Positive excess |
| ---: | ------------------------ | ------------------------ | ----------------: | ----------------------: | ---------------: | --------------- |
|    0 | `2017-02-02..2019-02-04` | `2019-02-05..2019-11-13` |               197 |        `0.108224316841` | `0.015705961893` | true            |
|    1 | `2017-02-02..2019-11-13` | `2019-11-14..2020-08-26` |               197 |        `0.122519471831` | `0.135939868633` | true            |
|    2 | `2017-02-02..2020-08-26` | `2020-08-27..2021-06-09` |               197 |        `0.096141253516` | `0.044872572075` | true            |
|    3 | `2017-02-02..2021-06-09` | `2021-06-10..2022-03-21` |               197 |        `0.029050164251` | `0.080840835451` | true            |
|    4 | `2017-02-02..2022-03-21` | `2022-03-22..2022-12-30` |               197 |       `-0.081074072668` | `0.130497425901` | false           |

The sample met the preregistered power floors, so the result is not classified as insufficient. The valid rejection is
caused by both adjusted lower confidence bounds remaining below zero.

## Doubled-cost causal-path and terminal-cash proof

The shared v2 doubled-cost validator returned `PASS` under schema
`bayn.candidate-development-doubled-cost-check.v1`.

- Signal-decisions hash: `7f81c46b3fe6eb68885ab9f9a0b0fdd5fdb43a8d26b72d93e95e325976564c60`.
- Ordered requested/filled quantity-path hash:
  `e6eb0b724c474ae53009981885b101525a145b956617bd9d253e0e3e0f276696`.
- Execution-model hash: `5e8fa97162f0f5818e50c78ccb66be235a19b391ba21880fac442663a69de2f4`.
- Baseline cost multiplier: `1000000` micros.
- Stressed cost multiplier: `2000000` micros.
- Invariants: `signal-decisions` and `ordered-order-quantity-path`.
- Divergence disposition remained `INVALID_PROTOCOL_DEVIATION`, but no divergence occurred.

Terminal cash was true for all four paths:

```text
strategy=true
buyAndHold=true
directVolatility=true
doubleCostStrategy=true
```

The invariant-quantity stressed replay remained non-borrowing. Candidate 15 therefore failed statistically, not because
of a quantity-path divergence or a protocol breach.

## Holdout and zero-mutation attestation

The holdout remains exactly:

```text
start=2023-01-03
end=2025-12-31
inspected=false
accessCount=0
```

No query mentioned or spanned a holdout date. No holdout bar, return, metric, hash, or qualification result was accessed.

The evaluation streamed the exact bundle to standard input of the already-running Bayn pod. It did not write a bundle or
preregistration file into the container. Candidate 15 performed no broker mutation, order submission, capital grant,
database write, runtime composition change, manifest edit, GitOps change, deployment, authority change, or production
strategy replacement.

Post-evaluation runtime state remained:

- Argo revision `66a973a11ed3c46a25624c324705136e8fb72233`, `Synced`, `Healthy`, operation `Succeeded`.
- Deployment ready `1/1` on source `22dc894ad8d3223cff2bf0edb7f1c1f123c372b4` and immutable digest
  `sha256:32e9b7df8d40c4359d5781e3ef2efe33b410c486b47073230f7f20faaac3f8cf`.
- Same pod `bayn-658b8988bc-pmkg5`, ready, with unchanged restart count `1` from the pre-evaluation observation.
- `BAYN_MAXIMUM_AUTHORITY=OBSERVE`.
- Broker provider `alpaca`, environment `sandbox`, base URL `https://paper-api.alpaca.markets`.
- Zero Candidate 15 orders and zero capital exposure.

## Required cleanup and final conclusion

Because the terminal result is `HOLD_REJECT`, the final branch must remove the Candidate 15 executable module, tests, CLI,
and package script while preserving the base, preregistration, evaluated implementation, this evidence, and cleanup
ancestry. The evidence PR must remain closed and unmerged.

Candidate 15 showed lower volatility and drawdown than SPY and a slightly higher point Sharpe, but its annualized return
was substantially lower and neither adjusted benchmark-relative lower bound was positive. It is not a qualified
profitable strategy and must not advance to holdout, terminal qualification, merge, deployment, capital, or order
authority.
