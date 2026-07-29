# Candidate ordinal 11 development rejection

Status: **HOLD_REJECT**

Candidate 11 evaluated exactly one preregistered development specification and failed the frozen benchmark-relative
uncertainty gates. It did not consume terminal qualification, inspect the holdout, alter production strategy state, or
exercise broker mutation or capital authority.

## Frozen specification

- Family: benchmark-anchored abnormal-volume continuation.
- Specification: `attention-volume-v125-s050`.
- Universe: `DBC,EFA,IEF,SPY,VNQ`.
- Signal: at each official month-end finalized close, require a non-SPY asset to have five-session average adjusted
  dollar volume at least 1.25 times the preceding 58-session average and a positive 21-session return relative to SPY.
- Selection: greatest abnormal dollar-volume ratio, then greater relative return, then ascending symbol.
- Allocation: 50% SPY and 50% selected challenger; otherwise 100% SPY.
- Execution: next official session open under Bayn's existing execution model, with terminal liquidation from the
  `2022-12-29` close at the `2022-12-30` open.
- Bounded selection multiplicity: one specification.
- Prior-attempt multiplicity: ten prior attempts; adjusted one-sided alpha `0.004545454545454546`.

## Immutable lineage and identities

| Binding                       | Exact value                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| Source base                   | `d00b261e6ea41ce5f44c0aea2a19a878d0df8162`                         |
| Preregistration commit        | `e0b412c55c54a4a9607f1b8db0ba3ee08b5d35c8`                         |
| Preregistration SHA-256       | `c3b149a90ea99dcd28e7a2a94e991dd30a4b5d8e4fef721ea9ad50a07cfc243d` |
| Initial implementation commit | `67afd9f3bbfba2af96538adbfe4cc1a64ca0cc51`                         |
| Evaluated commit              | `d370044d969869295a4a1253606971c2be6097ac`                         |
| Parameter hash                | `f49635c252aeb31c0114efd91f5467bf4b5c9b07d6d087415a1db65a89998894` |
| Behavior hash                 | `f7feeb257da608f55b96ee61131fe504f6111d6228e238e261c8da3e7e057e20` |
| Family strategy hash          | `090702d754bf102062d2d07be696478b7cdb3e82a926d5d696f4d8e6ed80c36c` |
| Family run ID                 | `9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118` |
| Specification strategy hash   | `e60b90cc83740e935ffd63e571b6b7912eda14329be46ce819c0c0b832a5f318` |
| Specification run ID          | `76954b9d164815eaab274efbe7234027949a93cb8a6ed18f1a0a95709a021a5c` |
| Canonical report hash         | `5c9c2e63905beb4fb3a86417e8cc98bc6ba0837547e59a896250ac5ade58a282` |
| Bootstrap samples hash        | `3250afa32564d7083466ba1759b16dee387ff3540f81088742e7fe664ffc7ee2` |
| Analysis hash                 | `7281d235eb67ae1ce54920a08ff1ec672933fcf8ae74a8acb3056eec1818dff7` |

The first attempted launch was blocked before evaluator process start and before ClickHouse I/O because the tool boundary
refused to export Kubernetes secret values into the local shell. No metric or return was observed. The only repair
between the initial implementation and evaluated commits replaced `Bun.file` preregistration reading with standard
`node:fs/promises` file reading so the same evaluator could execute inside the existing Bayn pod under its mounted
read-only identity. The frozen strategy/domain file SHA-256 values remained byte-identical:

| File                | SHA-256 before and after repair                                    |
| ------------------- | ------------------------------------------------------------------ |
| `model.ts`          | `a7ee1f5d655bdb0a85b88bf6293e8e1a2fdcf2295e1d679a43bd93fdd58e68bf` |
| `strategy.ts`       | `10b31f867c78b7b65229652d923a0a44f20b13a2456f983fcd89fc6acecea0ab` |
| `development.ts`    | `7581de924fd5341022c1b9d32dc226c06525c52afa4679f48f7f672b4a1ec911` |
| `holdout-access.ts` | `845e91f1c547fdfb9a27c7f2f149afb015098dd7ee98e899dece993b6a65d8c6` |

No strategy, parameter, universe, signal, date, cost, benchmark, selection rule, multiplicity, or gate changed.

## Frozen development data and geometry

| Binding                  | Exact value                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| Snapshot ID              | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`        |
| Sessions                 | `2016-01-04` through `2022-12-30`; 1,762 rows                             |
| Bars                     | 8,810 adjusted daily rows                                                 |
| Sessions content hash    | `30922ebdb9c1da58e0e6a78d1b4429b1c7c6e8de9cdce2a91a3f1abe9098efb8`        |
| Bars content hash        | `561234b2a784b25b0a58916192a45b0a503aca77268de640b6c353784b76aed4`        |
| Feature lookback         | 63 causal sessions                                                        |
| First eligible execution | signal `2016-04-29`, execution `2016-05-02`                               |
| Selected observations    | 1,489, from `2017-02-02` through `2022-12-30`                             |
| Geometry                 | 504 initial training observations plus five 197-session development tests |
| Bootstrap                | 5,000 paired non-wrapping complete-rebalance-block samples                |
| Power                    | 70 complete blocks / 69 required; 1,470 sessions / 1,449 required         |

## Exact development result

The stronger benchmark was SPY buy-and-hold.

| Metric                |          Candidate 11 |      SPY buy-and-hold |             Difference |
| --------------------- | --------------------: | --------------------: | ---------------------: |
| Annualized return     | `0.10402344145432951` | `0.13050708449541126` | `-0.02648364304108175` |
| Annualized volatility | `0.15222647808986156` | `0.20173366720422062` | `-0.04950718911435906` |
| Sharpe                |  `0.7264497904145817` |  `0.7091353287933215` | `0.017314461621260158` |
| Maximum drawdown      | `0.19969666824072285` |  `0.3379381857918785` | `-0.13824151755115565` |
| Annual turnover       |   `5.683590568848088` |  `0.5186166420987078` |     `5.16497392674938` |
| Total return          |  `0.7945152212169999` |  `1.0643222093140001` |  `-0.2698069880970002` |

Candidate ending equity was `$1,794,515.221217` from `$1,000,000`, versus `$2,064,322.209314` for SPY. Candidate
execution costs were `$420.76` in fees, `$8,432.472211` in spread cost, and `$8,394.932863` in slippage cost. Under the
frozen double-cost model the candidate still returned `0.10183679564006076` annualized with `0.7141353918877809`
Sharpe and `0.1998959952088537` maximum drawdown.

All point economic gates passed: finite metrics, 1,489 observations, positive net return, positive point Sharpe
improvement, drawdown below 35%, turnover below 12x, positive double-cost return, and complete terminal cash.

The uncertainty decision was `REJECTED` for both frozen reasons:

- `NON_POSITIVE_EXCESS_RETURN_LCB`: annualized excess-return lower bound `-0.046115233279`.
- `NON_POSITIVE_SHARPE_DIFFERENCE_LCB`: Sharpe-difference lower bound `-0.390033520515`.

Walk-forward tests produced positive benchmark excess in four of five folds:

| Fold | Test interval                     |     Excess return | Maximum drawdown | Positive excess |
| ---: | --------------------------------- | ----------------: | ---------------: | --------------- |
|    0 | `2019-02-05` through `2019-11-13` |  `0.107772269129` | `0.066742706014` | yes             |
|    1 | `2019-11-14` through `2020-08-26` |  `0.235626606069` | `0.169840358807` | yes             |
|    2 | `2020-08-27` through `2021-06-09` |  `0.149662174131` | `0.094910006978` | yes             |
|    3 | `2021-06-10` through `2022-03-21` |  `0.056538819894` | `0.097272255921` | yes             |
|    4 | `2022-03-22` through `2022-12-30` | `-0.106487489296` | `0.165356790293` | no              |

## Terminal boundary

- Selected development specification: none.
- Development status: `HOLD_REJECT`.
- Holdout interval `2023-01-03` through `2025-12-31`: not inspected; access count `0`.
- Official terminal qualification trials consumed: `0`.
- Production strategy, runtime composition, broker/order paths, authority, capital, and deployment: unchanged.

The executable proof commit must remain in branch ancestry, but all Candidate 11 executable code is removed from the
final rejection tree. The rejection-only PR must remain closed and unmerged.
