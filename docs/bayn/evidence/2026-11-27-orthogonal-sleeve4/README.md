# Bayn Wave 1C: orthogonal intraday sleeve

**Decision: no promotion.** None of the 113 multi-year minute variants qualified in development. The rule locked for diagnostic holdout scoring lost money even at 2 bp round trip. The frozen sources also cannot establish orthogonality to all three v2 engines: only 3 of 66 overlap dates support the full reference, and Noise Area did not trade on those three dates. No v3 candidate or production changes are warranted.

## Experimental design

The [prespecified protocol](protocol.md), [development-only freeze](freeze.json), and [full trial ledger](results.json) are separate artifacts. The ledger contains **264 unique registered variants**: 113 multi-year minute, 118 live minute, and 33 daily SIP. All 113 multi-year rules were scored on development; only the frozen rule and its two predetermined neighbors were scored on its holdout. Live-only and SIP results are diagnostic and cannot replace the locked rule. The initial freeze ([a329b2f](https://github.com/proompteng/lab/commit/a329b2f082436e6afb389ce5b091a97f5555e280)) precedes successful holdout scoring. An initial attempt rejected the regular-only calendar before scoring returns; the benchmark-input adapter changed, and the registry, development hash, selected rule, and neighbors were verified unchanged before the rerun.

The hypotheses draw on [Lou, Polk and Skouras (2019)](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf) for overnight/daytime pressure, [Gao et al. (2018)](https://doi.org/10.1016/j.jfineco.2018.05.009) for intraday momentum, [Lo and MacKinlay (1990)](https://doi.org/10.1093/rfs/3.2.175) for lead–lag and cross-autocovariance, and [Heston, Korajczyk and Sadka (2010)](https://doi.org/10.1111/j.1540-6261.2010.01573.x) for cross-sectional continuation and reversals. [Barbon et al.](https://abarbon.com/assets/Liquidity_Provision_to_Rebalancing_Flows_from_Leveraged_ETFs_and_Equity_Options.pdf) provide an end-of-day rebalancing-flow rationale; the bar-only proxies here do not identify actual leveraged ETF flows or institutional orders. These are adapted hypotheses, not replications. In particular, the power-hour rule measures the first half hour from the regular open, not from the prior close. DSR follows the [Bailey and López de Prado selection/non-normality adjustment](https://doi.org/10.2139/ssrn.2460551), using the total count of 264 and the dispersion method in the protocol.

The research assumes completed bars are immediately usable and models execution at the next minute's **open**, not the signal close. A missing entry print is a no-fill; a missing regular-session exit makes the period's economics unavailable, not zero. The price proxy applies 2, 5 or 10 bp round-trip adverse slippage plus 0.21 bp on the sale. These are **modeled consolidated NBBO stresses**, not historical NBBO quotes; the single-venue IEX spread export is not used to price fills. See [Wave 1A](../2026-11-27-midday-beta-neutral/README.md) for the separate spread and protection experiment. Returns omit live borrow, fill capacity, order routing and timing, funding, and operating costs. The contemporary universe is retrospective. Results do not authorize trading.

During PR review the standalone I/O path moved into the Bayn Effect runtime. Comparing regenerated artifacts to the pre-review evidence changed only the two I/O source digests; the locked registry, selection, benchmark, scores, and decision are identical. No hypotheses were retuned.

## What the frozen data support

| Input           | Verified coverage and limitation                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seven-symbol 1m | AAPL, AMZN, IWM, NVDA, QQQ, SMH, SPY; 1,724,388 source regular-session bars. Pre-June 10, 2024 NVDA OHLC divided by 10 and volume multiplied by 10. Sessions Aug 25 onward use the live source wholesale; overlapping bars are never blended.                                                                                                                                                                         |
| Live 1m         | 513,643 regular-session bars across **22 observed symbols**, not 26. IEF, VNQ, DBC and EFA are absent from the minute payload despite the manifest description. The 66 evaluation dates have a mean of 16.73 distinct tapes/day. Macro momentum/lead–lag is untestable, not a zero-return result.                                                                                                                     |
| Daily SIP       | 17 symbols, including SPY and eight semis, but **not IWM, QQQ or SMH**. The four-index daily portfolio is untestable. Standalone SPY and the eight-semi portfolio are diagnostics; the panel has 2,012 pre-2024 dates but semiconductor coverage does not extend across all those dates. A same-open gap decision and fill cannot be proven from daily OHLCV. Only NVDA among those semis has multi-year 1m coverage. |
| Calendars       | The pinned JSON regular sessions and compressed NYSE TSV agree. Core: 374 Train, 189 Validation, 166 Holdout sessions. Fixed afternoon exits skip known early closes.                                                                                                                                                                                                                                                 |

## Results by family

Figures are additive basis points of a fixed sleeve budget. The last column counts variants with **positive ex-top-five** at 5 bp / 10 bp in the stated panel. Positive raw returns alone are not sufficient.

| Family                                  | Panel and scored rules                                                        | Positive ex-top-five, 5 / 10 bp   |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| A, opening-gap absorption/continuation  | 36 core Validation; 18 live                                                   | 0 / 0 core; 0 / 0 live            |
| B, power-hour continuation              | 24 core Validation; 18 live macro variants untestable                         | 0 / 0 core                        |
| C, cross-asset lead–lag/rotation        | 9 core Validation; 12 live macro variants untestable                          | 0 / 0 core                        |
| D, afternoon cross-sectional dispersion | 48 live                                                                       | 0 / 0 live                        |
| E, multi-day context                    | 44 core Validation; 22 live; 22 SIP Holdout, 11 SIP index variants untestable | 1 / 0 core; 0 / 0 live; 0 / 0 SIP |

- **D:** The best 5 bp ex-top-five result, the 14:00 40 bp dispersion fade of three leaders and three laggards in the v2 roster, was +37.16 bp raw but **−80.64 bp** ex-top-five (bootstrap p = 0.2595). The roster includes IWM; restricting to single stocks did not rescue the result. An independent Midday relationship cannot be inferred from three matched reference dates.
- **E:** The 09:45 volatile-gap NVDA variant cleared 5 bp ex-top-five in Validation by only **+11.16 bp** (bootstrap p = 0.1059); no E variant cleared it at 10 bp. The strongest SPY SIP holdout gap proxy returned +237.18 bp at 5 bp but **−236.11 bp** ex-top-five. The eight-semi counterpart returned +128.26 bp but **−607.84 bp** ex-top-five, with decisions observable on 77 of the 166 holdout dates. No SIP result establishes executable minute returns.

### Frozen diagnostic: `A.core.gap-fade.indexes.5-60.0.75.0`

Fade the unconfirmed overnight gap in SPY/QQQ/SMH/IWM if it reaches 0.75 prior ATR; enter 09:35 and exit 10:30. This was the least negative core Validation 10 bp ex-top-five score, **not** a development qualifier.

| RT cost | Train net / ex-top-five | Validation net / ex-top-five | Holdout net / ex-top-five | Holdout bootstrap p |   Holdout DSR |
| ------: | ----------------------: | ---------------------------: | ------------------------: | ------------------: | ------------: |
|    2 bp |        −62.87 / −506.77 |              +1.36 / −114.97 |         −207.55 / −508.82 |              0.7853 |     0.0000833 |
|    5 bp |       −131.98 / −565.28 |             −24.95 / −134.60 |         −251.88 / −542.67 |              0.8312 |     0.0000335 |
|   10 bp |       −247.15 / −662.78 |             −68.81 / −170.94 |         −325.78 / −599.08 |              0.8928 | 0.00000000155 |

Holdout had 30 traded days, 59 intended and 59 entered legs, and no unresolved exits. Its three chronological folds at 5 bp returned −11.21, +10.21 and −250.89 bp. Neither frozen neighbor passed the 5 or 10 bp holdout economic gate. Every leave-one-symbol-out variant stayed negative ex-top-five at both stresses. That failure is independent of missing correlation evidence.

The comparison used the existing bar replay under v2 policy hash `f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509`. A full baseline was absent on 63 of 66 overlap dates; only Nov 23–25 were fully supported. There were zero co-active Morning or Noise dates with the diagnostic and one co-active Midday date. The ledger retains paired counts and raw descriptive coefficients, but Noise has zero variance and the other coefficients are not interpretable as stable correlations. Seven-symbol history does not contain the full Morning/Midday universes and cannot fill the missing reference years.

## Reproduce and continue

Run on the experiment revision with a Bun environment able to read the pinned S3 objects (or give the directory holding the exact compressed exports as the final argument). The CLI creates new files and refuses to overwrite an existing receipt or ledger.

```sh
study=services/bayn/tools/research-orthogonal-sleeve4.ts
evidence=docs/bayn/evidence/2026-11-27-orthogonal-sleeve4
work=$(mktemp -d)
bun "$study" --freeze "$work/freeze.json"
bun "$study" --score "$evidence/freeze.json" "$work/results.json"
bunx oxfmt "$work/freeze.json" "$work/results.json"
cmp "$evidence/freeze.json" "$work/freeze.json"
cmp "$evidence/results.json" "$work/results.json"
```

Do not tune or pick a replacement from this holdout. To qualify a new candidate, commit its hypothesis before a fresh chronological holdout and obtain date-aligned v2 returns with adequate active reference coverage. To evaluate the untested portions of B, C and E, the missing frozen intraday macro symbols, daily index series and multi-year semiconductor minute series need verified export receipts. Neither an expanded tape nor more reference dates would reverse the observed losses of the frozen diagnostic.
