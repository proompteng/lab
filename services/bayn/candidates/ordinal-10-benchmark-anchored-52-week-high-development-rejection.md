# Candidate ordinal 10: development rejection

Status: **HOLD_REJECT — terminal qualification not consumed**

Candidate 10 was evaluated exactly once on the frozen `2016-01-04` through `2022-12-30` development calendar. No
specification passed the preregistered development gates. The untouched `2023-01-03` through `2025-12-31` holdout was
not queried, inspected, summarized, or qualified.

## Immutable provenance

| Evidence                | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| Source base             | `d00b261e6ea41ce5f44c0aea2a19a878d0df8162`                         |
| Preregistration commit  | `6530542d246047c7cfc6ef62f4ac1996feb5524d`                         |
| Preregistration SHA-256 | `40e00e6aed866e3576774ccf3125d7dea1f7a5ce7f5e15454c5caf58f96af87b` |
| Evaluated proof commit  | `52c22115a5631ca9d3cbc28e4f7025170c6d0fdc`                         |
| Parameter hash          | `e7f107757051907b416fa7b615d06bda238bddb1902e452ba3809c276f73ba64` |
| Behavior hash           | `19f7f41880ed07d6a29b14fb6200c203f4239dff2a56a4b25e23f56fff93bb97` |
| Family strategy hash    | `a0c3dfab3b8fac31baaef3f53da52bca61f097ab4ffbe596379d26ca1830d598` |
| Development run ID      | `bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc` |
| Development report hash | `6683c713bd11dd92ef29e6608235fe7d47932c41e7780f0f8f0243160337f576` |

The metric-bearing command ran once with evaluated commit
`52c22115a5631ca9d3cbc28e4f7025170c6d0fdc`. It completed both bounded development queries and produced metrics without
a transport or query-schema correction. Credentials were supplied only through process environment variables and were
not recorded in the report or repository.

## Frozen data and geometry

| Binding                  | Observed value                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| Snapshot                 | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`               |
| Sessions                 | 1,762, from `2016-01-04` through `2022-12-30`                                    |
| Bars                     | 8,810 across `DBC,EFA,IEF,SPY,VNQ`                                               |
| Sessions content hash    | `8740738e9d16a545f758819e8f56eac2d8fee643d7cdcda50b067675782a130f`               |
| Bars content hash        | `90c8f641a14508bd57b1397cf977d5802beb922becdc3160719da1558010f945`               |
| Selected observations    | 1,489, from `2017-02-02` through `2022-12-30`                                    |
| Walk-forward geometry    | 504 initial training observations plus five chronological 197-session test folds |
| Bootstrap                | 5,000 paired, non-wrapping, complete-rebalance-block samples                     |
| Complete blocks          | 70 available versus 69 required                                                  |
| Complete sessions        | 1,470 available versus 1,449 required                                            |
| Family multiplicity      | Three frozen specifications after nine prior candidate attempts                  |
| Adjusted one-sided alpha | `0.0016666666666666668`                                                          |

The three-way multiplicity correction leaves fewer than the policy's minimum required bootstrap-tail observations at
5,000 samples, so every specification also reported `INSUFFICIENT_BOOTSTRAP_TAIL`. This was a frozen development gate
and was not changed or rerun after metrics. Independently of that uncertainty result, all three specifications failed
the point benchmark-Sharpe gate by substantial margins.

## Measured result

The stronger point benchmark was SPY buy-and-hold for every specification: 10.8854121955% annualized return, 19.5849%
annualized volatility, 0.6261106133 Sharpe, and 33.7938% maximum drawdown. The direct 10%-volatility SPY benchmark
returned 5.9967506387% annualized with 0.5444198206 Sharpe.

| Specification         | Annualized return |       Sharpe | Excess return vs SPY | Sharpe difference | Excess-return LCB | Sharpe-difference LCB | Max drawdown | Annual turnover | Double-cost return | Positive folds | Result |
| --------------------- | ----------------: | -----------: | -------------------: | ----------------: | ----------------: | --------------------: | -----------: | --------------: | -----------------: | -------------: | ------ |
| `high-proximity-h000` |     1.7110667337% | 0.2087134712 |       −9.1743454618% |     −0.4173971421 |    −9.8458535113% |         −1.8530128068 |     25.9062% |        10.1674x |      1.2845891395% |            3/5 | Reject |
| `high-proximity-h010` |     4.6876769373% | 0.4500789785 |       −6.1977352582% |     −0.1760316348 |    −7.2497908973% |         −1.4058121705 |     25.9061% |         7.5353x |      4.3779888408% |            4/5 | Reject |
| `high-proximity-h020` |     3.0900947323% | 0.3113166756 |       −7.7953174632% |     −0.3147939377 |    −9.3201275234% |         −1.4839061830 |     25.9062% |         6.5974x |      2.8005238198% |            4/5 | Reject |

`high-proximity-h010` was the strongest point result, but it still captured less than half of SPY's annualized return
and failed the benchmark-Sharpe gate. Its first four development folds had positive excess return; the final
`2022-03-22` through `2022-12-30` fold lost 17.9694543008% relative to the selected benchmark and reached a 25.9061%
drawdown. No specification was selected.

## Terminal boundary

- Development status: `HOLD_REJECT`.
- Selected specification: none.
- Holdout inspected: `false`.
- Holdout access count: `0`.
- Candidate 10 terminal qualification consumed: no.
- Production qualification, deployment, broker authority, orders, and capital promotion: unchanged.

The executable research implementation is removed from the final branch tree after this evidence commit. The
preregistration and evaluated proof commits remain ancestors of the cleanup head so the exact rejected implementation
and its deterministic tests remain durably reachable without contaminating `main`.
