# Wave 2C — SIP breadth did not clear execution costs

**No promotion.** Across 729 sessions, none of the 347 registered trials was net positive at 10 bp round trip plus the 0.21 bp sell fee in Train, Validation, or the full sample. At 5 bp, **no** trial had positive Validation net after removing its five best days. The development [freeze](freeze.json) nominated no trial. The holdout in [results.json](results.json) is therefore descriptive, not a new selection round. No v3 candidate, live-policy change, or migration is warranted.

The exact 18-vs-50 **stock-only** experiment cannot be run on the supplied tape. Bayn's 18-name Midday control includes IWM. The manifest's 50-name comparison also includes QQQ, SMH and SPY, for **46 stocks total**. The 17-vs-46 comparison below keeps ETFs out of orders; the separately labeled 18-vs-50 control retains the manifest names. Closing the stock-only evidence gap requires an amended, checksummed tape with at least four more predeclared equities and an explicit 18-stock baseline (including an equity replacement for IWM).

## Breadth and depth head-to-head

All entries are at noon ET, sign-gated SPY-relative VWAP, equal dollars, 500/800 bp brackets and timed flat. Amounts are USD, nearest dollar; Sharpe is annualized. Costs include the sell fee at both stresses.

| Universe       | Pairs | 5 bp net | 5 bp Sharpe | 5 bp Ex-Top-5 | 10 bp net | 10 bp Sharpe | 10 bp Ex-Top-5 |
| -------------- | ----: | -------: | ----------: | ------------: | --------: | -----------: | -------------: |
| Bayn 17 stocks |     2 |   37,876 |        0.65 |        14,462 |   −25,376 |        −0.43 |        −48,336 |
| 46 stocks      |     2 |   54,681 |        0.72 |        26,608 |    −9,629 |        −0.13 |        −37,250 |
| 46 stocks      |     3 |   −5,725 |       −0.09 |       −29,582 |   −69,903 |        −1.12 |        −93,310 |
| 46 stocks      |     4 |  −11,046 |       −0.21 |       −31,743 |   −75,023 |        −1.40 |        −95,267 |
| 46 stocks      |     5 |  −17,967 |       −0.37 |       −36,330 |   −81,716 |        −1.70 |        −99,627 |
| 46 stocks      |     6 |  −28,020 |       −0.64 |       −43,916 |   −91,436 |        −2.10 |       −106,877 |
| Bayn 18 mixed  |     2 |   28,740 |        0.49 |         5,326 |   −34,871 |        −0.59 |        −57,830 |
| 50 mixed       |     2 |   54,265 |        0.71 |        26,192 |   −10,045 |        −0.13 |        −37,666 |
| 50 mixed       |     3 |   −6,230 |       −0.10 |       −30,087 |   −70,437 |        −1.13 |        −93,844 |
| 50 mixed       |     4 |  −13,369 |       −0.25 |       −34,066 |   −77,391 |        −1.44 |        −97,635 |
| 50 mixed       |     5 |  −19,472 |       −0.41 |       −37,835 |   −83,310 |        −1.74 |       −102,495 |
| 50 mixed       |     6 |  −28,282 |       −0.65 |       −44,177 |   −91,803 |        −2.10 |       −107,244 |

At equal depth, expanding the stock pool improved 5 bp net by **$16,805** and Ex-Top-5 by **$12,146**. Deploying more pairs did reduce sample daily P&L standard deviation (about $1,662 to $950 from two to six pairs), but the edge deteriorated faster: at 10 bp, net dropped by $81,807 and Ex-Top-5 by $69,627. This is evidence against this implementation of deeper baskets, not against diversification in general. The v2-style control does not reproduce Wave 1A's tape, borrow gates, or Wave 1E's modeled collar fills.

## Chronology and concentration

These are the 46-stock, two-pair noon control's results. All trial-level windows and both stress cases are available in the scorecard, along with the 2 bp sensitivity. The two 2026 half-year rows are calendar slices, not substitute Train/Validation/Holdout definitions.

| Window     | Sessions | Net at 5 bp | Ex-Top-5 at 5 bp | Net at 10 bp | Ex-Top-5 at 10 bp |
| ---------- | -------: | ----------: | ---------------: | -----------: | ----------------: |
| Train      |      374 |      13,747 |           −8,560 |      −18,615 |           −40,470 |
| Validation |      189 |       8,312 |          −12,985 |       −8,701 |           −29,545 |
| Holdout    |      166 |      32,622 |            7,268 |       17,688 |            −7,217 |
| 2024H1     |      124 |        −811 |          −19,496 |      −10,711 |           −28,945 |
| 2024H2     |      128 |      28,354 |            8,664 |       16,877 |            −2,361 |
| 2025H1     |      122 |     −13,796 |          −29,641 |      −24,781 |           −40,168 |
| 2025H2     |      128 |       3,995 |          −14,777 |       −7,533 |           −25,856 |
| 2026H1     |      123 |       8,394 |          −16,271 |       −2,678 |           −26,890 |
| 2026H2     |      104 |      28,545 |           10,851 |       19,198 |             1,953 |

The highest 10 bp Train Sharpe was **−0.04** (46 stocks, 2L+2S, SPY-relative at 10:30). Its Train net was **−$1,667**, Ex-Top-5 **−$29,617**, and bootstrap p **0.513**. It had the highest 10 bp full-sample Sharpe too (−0.07, net −$6,373, Ex-Top-5 −$38,029). No plateau can rescue a trial that fails Train economics.

The numerically strongest 10 bp holdout Sharpe, identified only after opening the holdout, was **1.77** (two-pair VWAP-Z at 12:30; net $22,797, Ex-Top-5 $5,534). Its bootstrap p was **0.105**, DSR **0.182**, and Ex-Top-10 **−$6,896**. It was not nominated and is not evidence of a qualified configuration. At 5 bp, 35/347 configurations were full-sample net positive, but positive net alone is not the registered gate.

LOSO recomputed baskets rather than subtracting contributions. At 10 bp, the 46-stock four-pair noon control went from **−$75,023** to a worst leave-one-out net of **−$90,198** without SMCI. The same omission took the four-pair sector residual from **−$88,535** to **−$102,140**. Neither was viable before or after removal.

## Matched signal, timing, exit and sizing ablations

The fixed comparison is 46 stocks, four pairs, noon ET, at 10 bp RT. Rows change one mechanism unless indicated. The timing scan's six fixed-clock trials all lost money at this depth; noon was least negative. The two waves both carried risk for part of the day and shared one gross budget.

| Mechanism                              |      Net | Sharpe | Ex-Top-5 |
| -------------------------------------- | -------: | -----: | -------: |
| SPY relative, wide brackets            |  −75,023 |  −1.40 |  −95,267 |
| Median-demeaned VWAP                   |  −76,709 |  −1.42 |  −96,953 |
| Sector ETF residual                    |  −88,535 |  −1.69 | −107,878 |
| Demeaned from-open return              | −141,185 |  −2.62 | −162,155 |
| VWAP Z                                 |  −85,559 |  −1.82 | −103,163 |
| IQR gate 35 bp                         |  −74,576 |  −1.40 |  −94,820 |
| IQR gate 50 bp                         |  −73,812 |  −1.40 |  −94,056 |
| IQR gate 75 bp                         |  −45,368 |  −0.98 |  −65,612 |
| Nagel-inspired gross scaling           |  −70,516 |  −1.37 |  −90,760 |
| Inverse-vol leg weights                |  −73,617 |  −1.44 |  −92,429 |
| Moreira–Muir-inspired variance scaling |  −80,876 |  −1.54 | −101,120 |
| ATR brackets                           |  −82,955 |  −1.36 | −112,813 |
| VWAP cross, catastrophe stop           | −106,385 |  −1.88 | −122,823 |
| Timed flat, catastrophe stop           |  −87,964 |  −1.52 | −113,333 |
| Two waves (10:30/12:00 entries)        | −109,982 |  −3.04 | −120,448 |

The 75 bp gate reduced active days from 715 to 450 and reduced losses; it did not produce positive trimmed P&L. Inverse-vol legs slightly reduced net losses but did not improve Sharpe. The tested VWAP exit and staggered entries both worsened this matched control. None of the other registered variants passed the full set of gates.

## Data and reproduction

- SHA-256 and byte counts authenticate the supplied S3 archive. Of **3,923,737** validly routed rows, **3,480,548** were regular-way RTH bars, **442,813** were outside RTH, and **376** were SNDK RTH bars predating regular-way listing. The calendar has six early closes. The scorecard preserves per-symbol coverage; baseline trials did not backfill or shift timestamps. Across main ledgers the maximum was 42 missing in-position bar slots and one partial basket in a trial; every main-trial position resolved. No missing exit was zero-filled.
- Train had 374 sessions, Validation 189 and Holdout 166. Freeze receipt: first [published before scoring](https://github.com/proompteng/lab/commit/aab9cde11fede48f25b70e6ede9ab75d7d27b09a), then reworded to `b04836d1794791fb324936a0b1085fc3b49589e5` to pass the conventional-commit gate. The receipt bytes were unchanged, SHA-256 `13b661961625f2b3b03d75e788610a7b52bc214ee7787faa7435efde782fc949`. Score SHA-256: `0fc94bdf6ea1195a692d9167c63e089de06421e79e545a62d3941ae761fa7c3b`. The score command reproduced the exact development bytes **before** generating holdout trades. Re-scoring after the reword changed only the recorded receipt commit ID.
- Reproduce at receipt commit `b04836d1794791fb324936a0b1085fc3b49589e5`, with the authorized S3 variables or `--input-dir` containing the three unchanged input files. Use that exact revision: the CLI binds the source bytes in the receipt, including shared helpers that may change on `main`. Write to new paths; the commands refuse to overwrite output.

```sh
bun services/bayn/tools/research-3yr-sip-62sym-statarb.ts --freeze --output /tmp/wave2c-freeze-reproduced.json
bun services/bayn/tools/research-3yr-sip-62sym-statarb.ts --score --output /tmp/wave2c-results-reproduced.json
```

See the [pre-registered protocol](protocol.md) for signal, eligibility, allocation and test definitions. The bar-cost study has no observed NBBO, locates, market-impact, or queue evidence. The supplied dates end November 25, 2026; the closing half-year is partial. Neither a cluster deployment nor a change to policy v2 or migrations 0222/0223 is part of this evidence.
