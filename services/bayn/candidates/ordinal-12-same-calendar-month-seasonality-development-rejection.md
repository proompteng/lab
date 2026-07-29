# Candidate ordinal 12: development rejection

Status: **HOLD_REJECT — terminal qualification not authorized**

Candidate 12 evaluated the singleton `same-month-seasonal-excess-lag1` specification exactly once on the frozen
development interval. It remained profitable after declared and double execution costs, satisfied the power geometry,
and produced positive benchmark excess in four of five chronological folds. It nevertheless failed the point Sharpe
gate and both prior-attempt-adjusted lower-confidence-bound gates by a wide margin. The untouched `2023-01-03` through
`2025-12-31` holdout was not inspected or queried.

## Immutable lineage

| Binding                           | Exact value                                                        |
| --------------------------------- | ------------------------------------------------------------------ |
| Base commit                       | `d00b261e6ea41ce5f44c0aea2a19a878d0df8162`                         |
| Preregistration commit            | `7be1b88d8d7551c892dfdc94bb6971171e22b529`                         |
| Preregistration SHA-256           | `601ec9f30fe3117bc786a4dc596fc7665601fb628f6446f2f74983ef133c3ba5` |
| Evaluated executable commit       | `81790d2e342bc97d4474f203bcdb4946e2b803b1`                         |
| Dataset snapshot                  | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0` |
| Dataset sessions content hash     | `381c4ac7ee12710541c813feba08453e55f1fc3272319c8324724eeb346e555a` |
| Dataset bars content hash         | `b98546c9063cadeafd291b8f78b8ba48e9b2ca5cff1c5b8bd5c087a5aaaac82a` |
| Parameter hash                    | `13ea0a3612a81d3028c344ef87542492b13b2f3a6ccb3e5e9dd64c618bfbd0e1` |
| Behavior hash                     | `ab51be6b08bcafb5fde666e63a05564dcd6879efd169c882adffba70e7b01e34` |
| Family strategy hash              | `5516f6c1b769a003485cc88999f4a544b9c2583c639b72a424e712c8a520e0e2` |
| Family run ID                     | `b38d784ce8124bbbff7513a9f8c94ec6ac4d51d7c01bf5c369bcfe3bc5aa2183` |
| Specification strategy hash       | `910965a87613d2d73dbaa8e95ab4ecd11073c4c24b276c2dfe5063044949dd4f` |
| Specification run ID              | `fdff338cbd3a84fdb04644ef8f17b8842706144050960199fb0b4bc539485de3` |
| Bootstrap samples hash            | `08a0f908b2a6399a6787cf6253bffacbae10221b65ecf6102add42f0e2671aaa` |
| Statistical analysis hash         | `0623dd15169ce08474b4157210f9a26acb59de2ea0623afc71a3a357299b18ac` |
| Development report identity       | `fd07334cd8680b9a95e5438e7e72d1198292e115770a114a26e4b6f2ce74eeb4` |
| Exact command-output file SHA-256 | `3e90bd7281d450b3df66ab1b4aad87c6bdcae86e9e76433a0dbfedb735ce86c1` |

The exact command output was retained only as temporary execution evidence while this human-readable rejection record
was constructed; no JSON evidence dump is added to the repository.

## One-shot execution record

The first process invocation failed before configuration completed, before preregistration, before ClickHouse I/O, and
before any metric existed. The local agents-shell image provides BusyBox `base64`, which rejected the GNU-only
`--decode` flag used by the credential-decoding wrapper. The process emitted zero report bytes and
`Candidate12IoFailure:load-config`. No strategy, parameter, date, cost, benchmark, selection rule, gate, source file,
preregistration byte, or evaluated commit changed. The wrapper alone was corrected to use BusyBox-compatible `base64
-d`.

The next invocation was the sole metric-bearing development evaluation. It ran the package command
`candidate:12:development`, used `runCandidateDevelopment`, bound the exact evaluated commit above, produced one report,
and exited `2` for the frozen `HOLD_REJECT` result. It was not rerun.

## Frozen data and geometry actually evaluated

- Development data: `2016-01-04` through `2022-12-30` only.
- Exact official calendar: 1,762 sessions and 8,810 all-adjusted daily bars for `DBC,EFA,IEF,SPY,VNQ`.
- First eligible execution: `2017-02-01`, from the finalized `2017-01-31` signal.
- Selected comparison observations: 1,489, from `2017-02-02` through `2022-12-30`.
- Geometry: 504 initial training observations followed by five chronological, non-overlapping 197-session development
  folds. One eligible observation was intentionally unused by the end-anchored geometry.
- Multiplicity: one frozen specification plus eleven prior attempts; one-sided alpha
  `0.05 / 12 = 0.004166666666666667`.
- Bootstrap: 5,000 paired, non-wrapping, complete-rebalance-block samples with 20 lower-tail samples.
- Power: 70 complete rebalance blocks versus 69 required and 1,470 complete sessions versus 1,449 required.
- Selected benchmark: SPY buy-and-hold, because its point Sharpe exceeded the direct-volatility SPY benchmark.
- Terminal cash checks: strategy, SPY buy-and-hold, direct-volatility SPY, and double-cost strategy all passed.

## Exact development metrics

| Metric                      | Candidate 12           | SPY buy-and-hold      | Direct-volatility SPY | Candidate at double costs |
| --------------------------- | ---------------------- | --------------------- | --------------------- | ------------------------- |
| Observations                | 1,489                  | 1,489                 | 1,489                 | 1,489                     |
| Total return                | `0.19903466916`        | `0.8414113282769999`  | `0.41073962511499995` | `0.16219306583600002`     |
| Annualized return           | `0.031196833125716195` | `0.10885412195491528` | `0.05996750638676862` | `0.02576474377162441`     |
| Annualized volatility       | `0.12085319223156205`  | `0.1958486063843709`  | `0.12035750340021738` | `0.12088884826233125`     |
| Sharpe                      | `0.31474697718717237`  | `0.6261106133105618`  | `0.5444198206211452`  | `0.27099640983930945`     |
| Maximum drawdown            | `0.19962651075258786`  | `0.33793804201984956` | `0.25461900836879736` | `0.20978882481568306`     |
| Annual turnover             | `10.641571549406327`   | `0.48088993816188313` | `1.5395889215634841`  | `10.471096816847805`      |
| Total fees, micros          | `801000000`            | `38970000`            | `102050000`           | `1577230000`              |
| Total spread cost, micros   | `15808571490`          | `710745942`           | `2276003763`          | `31030453065`             |
| Total slippage cost, micros | `15726760562`          | `710745942`           | `2274307660`          | `30926878628`             |
| Ending equity, micros       | `1199034669160`        | `1841411328277`       | `1410739625115`       | `1162193065836`           |

Benchmark-relative annualized return was `-0.07765728882919909`, or approximately `-7.7657` percentage points. The
point Sharpe difference was `-0.31136363612338946`.

## Gate disposition

The candidate passed finite metrics, the 504-observation minimum, positive net annualized return, maximum drawdown at
or below 35%, annual turnover at or below 12x, and positive annualized return under double costs. It failed the required
strictly positive point Sharpe improvement over the selected benchmark.

The adjusted bootstrap independently rejected the candidate for both frozen reasons:

- `NON_POSITIVE_EXCESS_RETURN_LCB`: annualized excess-return lower bound `-0.10360412761`.
- `NON_POSITIVE_SHARPE_DIFFERENCE_LCB`: Sharpe-difference lower bound `-1.498490188294`.

The five test folds had excess returns of `0.060251182888`, `0.065665320605`, `0.016489624771`, `0.281273127964`, and
`-0.097630427465`. Four of five were positive, satisfying fold stability. Their maximum drawdowns were
`0.050640181902`, `0.12697767394`, `0.0707289867`, `0.044100116229`, and `0.192267478431`, all below the unchanged 35%
fold ceiling.

## Terminal and authority disposition

No specification passed every development gate, so `selectedSpecificationId` is `null`. Terminal qualification was not
authorized and the holdout record remains exactly:

- `inspected: false`
- `accessCount: 0`

This rejection authorizes no deployment, PAPER or LIVE authority, broker mutation, order submission, or capital
promotion. Candidate 12 executable research code and package wiring are removed in the branch's final cleanup commit;
the preregistration, evaluated implementation, and this rejection proof remain durable in branch ancestry.
