# Candidate ordinal 12: invalid development attempt

Status: **INVALID_PROTOCOL_DEVIATION — attempt consumed; terminal qualification not authorized**

Candidate 12 consumed exactly one metric-bearing development attempt for the singleton
`same-month-seasonal-excess-lag1` specification on the frozen development interval. A post-run exact-commit audit found
that the evaluated double-cost path violated the immutable preregistration: it reran the simulation with doubled costs,
allowing cost-dependent equity and affordability to change requested quantities and turnover instead of applying
doubled costs to the ordinary-run quantities. The command's emitted `HOLD_REJECT` is therefore not a valid
preregistered development verdict. The attempt is classified `INVALID_PROTOCOL_DEVIATION`, is consumed, and cannot be
repaired or rerun after metrics were observed. The untouched `2023-01-03` through `2025-12-31` holdout was not inspected
or queried.

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

The next invocation was the sole metric-bearing development attempt. It ran the package command
`candidate:12:development`, used `runCandidateDevelopment`, bound the exact evaluated commit above, produced one report,
and exited `2` after emitting `HOLD_REJECT`. It was not rerun. The later exact-commit review identified the double-cost
protocol deviation described below, so the emitted status is retained only as raw output identity and is superseded by
the terminal research classification `INVALID_PROTOCOL_DEVIATION`.

The one metric-bearing attempt is consumed. Candidate 12 may not be rerun, retuned, repaired, or replaced under this
ordinal after metrics were visible. It authorizes no terminal qualification.

## Double-cost protocol deviation

The frozen preregistration required the double-cost simulation to double spread, slippage, and fees **without changing
signals or quantities**. Evaluated commit `81790d2e342bc97d4474f203bcdb4946e2b803b1` instead called the complete
`runSimulation` function twice: once with the ordinary cost multiplier and once with the doubled multiplier. The shared
simulator derives desired quantities from evolving planning equity and scales buys through a cost-dependent
affordability calculation. Higher costs therefore changed later equity, requested quantities, fills, and turnover.

The metric output confirms the changed trade path:

- ordinary annual turnover: `10.641571549406327`;
- doubled-cost annual turnover: `10.471096816847805`.

Those values cannot differ when the same quantities are held fixed. The doubled-cost return and every claim that the
candidate passed the preregistered double-cost gate are invalid. This defect cannot be corrected by rerunning because
the sole metric-bearing attempt has already exposed development metrics, and the preregistration forbids a post-result
protocol change or rerun.

## Frozen inputs and geometry used by the invalid attempt

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
- Terminal cash checks reported true for strategy, SPY buy-and-hold, direct-volatility SPY, and the nonconforming
  doubled-cost rerun. This does not cure the quantity-path deviation.

## Observed metrics from the invalid attempt

These values reproduce the sole command output and remain useful for audit identity. They do not constitute an exact
preregistered development evaluation, and the doubled-cost column is specifically nonconforming.

| Metric                      | Candidate 12           | SPY buy-and-hold      | Direct-volatility SPY | Nonconforming 2x-cost rerun |
| --------------------------- | ---------------------- | --------------------- | --------------------- | --------------------------- |
| Observations                | 1,489                  | 1,489                 | 1,489                 | 1,489                       |
| Total return                | `0.19903466916`        | `0.8414113282769999`  | `0.41073962511499995` | `0.16219306583600002`       |
| Annualized return           | `0.031196833125716195` | `0.10885412195491528` | `0.05996750638676862` | `0.02576474377162441`       |
| Annualized volatility       | `0.12085319223156205`  | `0.1958486063843709`  | `0.12035750340021738` | `0.12088884826233125`       |
| Sharpe                      | `0.31474697718717237`  | `0.6261106133105618`  | `0.5444198206211452`  | `0.27099640983930945`       |
| Maximum drawdown            | `0.19962651075258786`  | `0.33793804201984956` | `0.25461900836879736` | `0.20978882481568306`       |
| Annual turnover             | `10.641571549406327`   | `0.48088993816188313` | `1.5395889215634841`  | `10.471096816847805`        |
| Total fees, micros          | `801000000`            | `38970000`            | `102050000`           | `1577230000`                |
| Total spread cost, micros   | `15808571490`          | `710745942`           | `2276003763`          | `31030453065`               |
| Total slippage cost, micros | `15726760562`          | `710745942`           | `2274307660`          | `30926878628`               |
| Ending equity, micros       | `1199034669160`        | `1841411328277`       | `1410739625115`       | `1162193065836`             |

Benchmark-relative annualized return was `-0.07765728882919909`, or approximately `-7.7657` percentage points. The
point Sharpe difference was `-0.31136363612338946`.

## Non-authorizing diagnostic outputs

There is no valid frozen gate disposition because the complete preregistered evaluation protocol was not followed. The
ordinary-run and bootstrap outputs reported a negative point Sharpe difference and negative adjusted lower bounds, but
they remain diagnostic outputs from a consumed invalid attempt rather than an exact Candidate 12 development rejection.
The previous claim that Candidate 12 passed the double-cost gate is withdrawn.

The command reported these two statistical reason codes:

- `NON_POSITIVE_EXCESS_RETURN_LCB`: annualized excess-return lower bound `-0.10360412761`.
- `NON_POSITIVE_SHARPE_DIFFERENCE_LCB`: Sharpe-difference lower bound `-1.498490188294`.

The five test folds had excess returns of `0.060251182888`, `0.065665320605`, `0.016489624771`, `0.281273127964`, and
`-0.097630427465`. Four of five were positive, satisfying fold stability. Their maximum drawdowns were
`0.050640181902`, `0.12697767394`, `0.0707289867`, `0.044100116229`, and `0.192267478431`, all below the unchanged 35%
fold ceiling.

## Terminal and authority disposition

The command emitted `selectedSpecificationId: null`, but the controlling disposition is
`INVALID_PROTOCOL_DEVIATION`, not `HOLD_REJECT`. The one metric-bearing attempt is consumed and cannot be rerun. Terminal
qualification was not authorized, no terminal trial was consumed, and the holdout record remains exactly:

- `inspected: false`
- `accessCount: 0`

This invalid attempt authorizes no deployment, PAPER or LIVE authority, broker mutation, order submission, or capital
promotion. Candidate 12 executable research code and package wiring remain removed; the immutable preregistration,
evaluated implementation, original report-recording commit, and this corrective evidence remain durable in branch
ancestry.
