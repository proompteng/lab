# Candidate 6: month-end liquidity reversal

Status: **sealed implementation and development evidence only**. No official qualification trial, broker mutation, or
live-capital trade occurred.

## Immutable identity

- Candidate ordinal: `6`
- Strategy: `month-end-liquidity-reversal`
- Strategy version: `1.0.0`
- Parameter hash: `59889076e9cff0b8c79c30f8c095b50ae9c4cd6044fe536004f3432a3287a645`
- Strategy hash: `dc86a30c6c3e8e44a59c7a3c7f5de0f7965c98cacea31eba50baa265b153a273`
- Canonical preregistration hash: `7a7d12d05522af95964319e470b753a9f676c2a0afcf9bef31283ead0548b1b9`
- Canonical preregistration: `ordinal-6-month-end-liquidity-reversal-preregistration.json`
- Development report hash: `64d4f3ad11d83bccf4accfe92436d9ea79fb83cd51d6281f0799b8360c843c63`
- Development report: `ordinal-6-month-end-liquidity-reversal-development-report.json`
- Source base: `3a2d6aad649a5ec935b6efc291273f0818628ca5`

The JSON preregistration is the canonical decision identity. This document is explanatory and must not be used to
override a JSON field.

## Material distinction from candidate 5

Candidate 5 is a monthly, multi-horizon, own-market trend strategy across `DBC`, `EFA`, `IEF`, `SPY`, and `VNQ`, with
volatility-scaled cross-asset allocation. Candidate 6 is a single-market, calendar-conditioned, short-horizon reversal
strategy. It observes five-session SPY selling pressure through the fourth session before month-end, enters only when
expected reversion clears buffered round-trip costs, holds through the third session after month-end, and otherwise
holds cash. It does not reuse candidate 5's trend horizons, ranking, risk-balanced allocation, or parameterization.

## Primary research and economic hypothesis

Etula, Rinne, Suominen, and Vaittinen document low equity returns during `T-8` through `T-4`, a positive reversal during
`T-3` through `T+3`, institutional net selling around month-end liquidity dates, and stronger reversal evidence in large,
liquid stocks. The proposed mechanism is temporary price pressure caused by clustered institutional cash needs and
payment cycles rather than persistent trend. See _Dash for Cash: Monthly Market Impact of Institutional Liquidity
Needs_, Review of Financial Studies 33(1), 2020: https://doi.org/10.1093/rfs/hhz054.

Kayaçetin examines thirty equity markets over 1994–2023 and reports a persistent turn-of-the-month return concentration,
with evidence consistent with infrequent institutional rebalancing and risk deferral. This supports a broader modern
rebalancing mechanism rather than treating the older settlement convention as the sole cause. See _Infrequent
rebalancing, risk deferral, and equity returns at the turn of the month_, Journal of International Financial Markets,
Institutions and Money 109, 2026: https://doi.org/10.1016/j.intfin.2026.102309.

The U.S. standard equity settlement cycle changed to T+1 on May 28, 2024. This is a structural break for any
settlement-sensitive explanation. The sealed protocol therefore excludes May 28 through June 28, 2024 and requires
separate positive-net-return gates before and after the transition. See the SEC final rule and implementation notice:
https://www.sec.gov/rules-regulations/2023/02/34-96930 and
https://www.sec.gov/newsroom/press-releases/2024-62.

The hypothesis is empirical, not a profitability guarantee: temporary month-end institutional liquidity and rebalancing
pressure may partially reverse in SPY after sufficiently negative pressure through `T-4`.

## Frozen data boundary

- Development source snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`
- Snapshot manifest publication as-of: `2026-07-27`
- Snapshot manifest content hash: `7b1216c8d698da4b2e74a5a77584c9863608edab0ad1c7331f37d039ddb1a764`
- Raw manifest export SHA-256: `79400b64fcd981fc87874fbc0fd647033cfe8acadd1abb2f6a3f0af092699e43`
- Raw bounded bars export SHA-256: `c71ba30f3bcdd373708636f7c799d6caf3e24e07fd7d428522c69167c11a0c9c`
- Raw bounded official-session export SHA-256: `d0f182b5436c3ce374f4afaf2735c4b66247edfb78378aeff42af1efc889aabf`
- Authoritative manifest source: `signal.snapshot_manifests_v2`
- Official calendar version: `alpaca-us-equity-calendar-v1` from `signal.exchange_sessions_v1`
- Development data requested and observed: `2016-01-04` through `2022-12-30`
- Development simulation: `2017-01-03` through `2022-12-30`
- Export size: 8,810 cross-asset bars and 1,762 official sessions; all 1,762 SPY bars match the calendar exactly
- Untouched official qualification window: `2023-01-03` through `2025-12-31`
- Required official publication cut: `2025-12-31`

The available immutable snapshot catalog began after the development period. Research read one manifest metadata row,
then issued bounded bar and official-session queries containing `session_date <= 2022-12-30`. No bar or session row on
or after `2023-01-03` was queried, exported, simulated, or inspected. Every bounded bar carries the snapshot ID and
publication date and must match the independently decoded, canonically verified manifest. The raw exports are not
committed; only their identities and the deterministic report are committed. The simulator rejects any missing,
duplicate, or extra SPY bar relative to the sealed official session calendar, so omitted sessions cannot shift
`T-4`/`T+3` offsets.

## Frozen strategy and execution

- Tradable universe: `SPY` only; long or cash.
- Feature: `adjusted_close[T-4] / adjusted_close[T-9] - 1` using finalized adjusted daily bars.
- Entry: signal after finalized `T-4` close; execute at `T-3` next open.
- Cost-aware threshold: expected 50% reversion must exceed 1.5 times a modeled 10 bps round trip. This freezes the
  pressure threshold at `-0.30%` or lower.
- Exit: signal after `T+3` close; execute at `T+4` next open. Partial exits are retried fail-closed.
- Active-position lineage must name an entry signal no later than the current signal. A simulation fails closed unless
  every entered event has completed its exit before the evaluation boundary; truncated terminal events cannot contribute
  return, turnover, cost, or bootstrap evidence.
- Operating target: 30% SPY weight.
- Hard limits: 35% symbol and gross exposure; one-way turnover at most 100%; 20-session average dollar volume at least
  $100 million; intended notional at most 0.5% of average daily dollar volume.
- Costs: 2.5 bps half-spread plus 2.5 bps slippage per side, SEC/TAF/CAT sell fees, one-session latency, and a
  deterministic 10% probability of a 50% partial fill.
- Transition exclusion: no entry or held exposure from May 28 through June 28, 2024.
- Missing, blank, or whitespace numeric fields; missing, duplicate, or extra official-session bars; invalid calendar
  dates; manifest, snapshot, or publication mismatches; future, stale, non-finite, unadjusted, wrong-source, wrong-feed,
  wrong-schema, insufficient-history, or insufficient-liquidity inputs fail closed. No imputation is allowed.

## Development evidence

These results are design evidence only and are not the official trial.

| Metric                          |    Gross |       Net |
| ------------------------------- | -------: | --------: |
| Total return                    | 10.1087% |   8.4429% |
| Annualized return               |  1.6201% |   1.3619% |
| Annualized volatility           |  2.5329% |   2.4873% |
| Sharpe                          |   0.6472 |    0.5563 |
| Maximum drawdown                |  3.1231% |   3.1828% |
| Annual turnover                 |  2.8148x |   2.6141x |
| Average gross exposure          |  3.9029% |   3.6350% |
| Maximum observed gross exposure | 31.4316% |  31.4362% |
| Daily observations              |    1,510 |     1,510 |
| Entries                         |       28 |        28 |
| Orders                          |       56 |        57 |
| Partial fills                   |        0 |         5 |
| Modeled costs                   |       $0 | $8,385.97 |

The deterministic 2,000-replicate, 20-session moving-block bootstrap gives a 95% annualized-return interval of
`[-0.1931%, 3.0565%]` and a Sharpe interval of `[-0.0638, 1.2211]`. Both intervals cross zero. SPY buy-and-hold over the
same development simulation has 11.0948% annualized return, 19.4568% volatility, 0.6386 Sharpe, and 33.7938% drawdown.
Candidate 6's net development Sharpe is therefore 0.0824 below buy-and-hold; qualification is not implied.

Frozen two-year development folds have annualized net returns of 1.6239% for 2017–2018, 2.4185% for 2019–2020, and
0.0538% for 2021–2022. Calendar-year total returns are -0.0733%, 3.3368%, 1.2370%, 3.6236%, -0.1654%, and 0.2734% from
2017 through 2022. The low-volatility regime annualizes at 0.1989% versus 2.5386% in the high-volatility regime.

Annualized net return remains positive under the frozen cost sensitivity: 1.4295% at 0.5x cost, 1.3619% at 1x,
1.2268% at 2x, and 1.0919% at 3x. Development contains no post-T+1 observation, so no post-transition conclusion is
permitted.

## Official statistical protocol

The untouched official trial benchmark is a conservative zero-cost SPY buy-and-hold upper bound: buy at the first
qualification-session open, hold through the final close, and align to the same sessions. The trial requires at least 504
observations, positive annualized net return, positive candidate-minus-benchmark point Sharpe
improvement, a positive one-sided 95% lower confidence bound for Sharpe improvement, drawdown no greater than 35%,
annual turnover no greater than 12x, and positive return at double modeled costs. Statistical inference uses 5,000
complete month-end event-block bootstrap replicates with 5% family one-sided alpha.

The frozen walk-forward folds are calendar years 2023, 2024, and 2025, with no parameter updates between folds and at
least two positive-net folds required. The transition exclusion applies inside the 2024 fold. The pre-T+1 regime
(`2023-01-03` through `2024-05-24`) and post-transition T+1 regime (`2024-07-01` through `2025-12-31`) must each contain
at least twelve complete month-end events and positive net return.

## Exactly-once and lineage contract

Candidate 5 remains immutable and terminal `REJECTED`:

- Run ID: `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
- Result hash: `a603d712a8d948af7e7de42165b9e81c9a3b42a4ebd38b45753e69755d94cc75`
- Committed at: `2026-07-28T06:49:26.341076Z`
- Failed gate: `benchmark_sharpe_improvement`, actual `-0.09920172907261815`, required `> 0`

The pure admission function requires the exact terminal lineage for candidates 1–5, rejects candidate 5 selection or
rewriting, derives one trial identity from the candidate-6 preregistration hash, and rejects a second trial under that
identity. A terminal candidate-6 result, whether `QUALIFIED` or `REJECTED`, cannot be rerun.

No official candidate-6 qualification trial has been admitted or executed. No broker mutation or live-capital authority
is enabled by this candidate.
