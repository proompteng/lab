# Wave 24D: Intraday SIP liquidity profile

**SPY, QQQ and IWM ranked first, second and third on whole-session liquidity.** On the 5-minute tape,
**15:30–16:00 ET** ranked first for all 16 ETFs: it had the lowest observed Amihud ratio for every ETF
and the highest median dollar volume for 14. QQQ and GLD had their highest dollar volume at 09:30–10:00.

**No ETF or window qualified for B0 from this evidence.** The binding limiter is the absence of realized
round-trip fills against their execution benchmarks. SIP bars measure executed market turnover and price
movement, not executable spread, order-book depth or the slippage of a Bayn order. The
[B0 audit](../../live-profitability-audit-runbook.md) requires both the unrounded mean and median realized
slippage to be strictly below 2.5 bp; equality fails. The profiler leaves both values `null` and uses the
tiers only to prioritize measurement, not to grant execution authority.

## Verified coverage

The read-only run used the pinned manifest under `agents-artifacts/bayn-research-datasets/2026-11-27-sip-multiyear/`
and its registered calendar, covering **729 sessions** (six early closes) from **2024-01-02 through 2026-11-25**.
It verified the manifest and calendar hashes and both tapes' compressed and decoded byte counts, SHA-256
digests, and row counts before emitting [results.json](results.json). The manifest contains **62 symbols
at 5 minutes but only Bayn's 21 symbols at 1 minute**. The other 41 symbols have no verified 1-minute tape
in this archive; the results neither mix resolutions nor synthesize bars.

| Tape | Symbols / ETFs | Source rows | Outside RTH | Pre-regular-way RTH | Admitted / expected RTH bars |
| ---- | -------------: | ----------: | ----------: | ------------------: | ---------------------------: |
| 5m   |        62 / 16 |   3,923,737 |     442,813 |                 376 |        3,480,548 / 3,480,804 |
| 1m   |         21 / 4 |   6,491,892 |     671,670 |               1,098 |        5,819,124 / 5,836,830 |

Expected counts follow the exchange calendar and the regular-way starts for ALAB, GEV and SNDK, as in the
[prior SIP study](../../../../services/bayn/tools/research-sip-momentum-protocol.ts). The excluded pre-regular-way
RTH rows were SNDK. All 16 ETFs had all 56,646 scheduled 5-minute bars each. Each of their final-window
volume medians uses 723 sessions, not 729, because early closes have no 15:30 window. In the 1-minute ETF
subset, SPY, QQQ and IWM were complete; SMH was missing seven bars across six sessions and had 723 complete
sessions for its daily volume median.

## 5-minute ETF liquidity tiers

The table is ordered by the sum of descending daily dollar-volume rank and ascending daily Amihud rank.
Equal component values share a rank; equal sums favor the better dollar-volume rank, then ticker (or the
earlier time for a window). The three tiers are relative rank bands, not cost thresholds. Each ETF's
13 windows are ranked separately by the same method. The table rounds for display; the JSON retains the
computed values and both component ranks.

`A` is Amihud in bp per USD 1 million. GK / PK are native 5-minute volatility in bp. Gap is the 95th
percentile of absolute close-to-next-open gaps (728 pairs per ETF).

| Rank | ETF  | Tier    | Daily median USD bn | Daily A |    GK / PK bp | Gap p95 bp | 15:30 median USD m | 15:30 A |
| ---: | ---- | ------- | ------------------: | ------: | ------------: | ---------: | -----------------: | ------: |
|    1 | SPY  | Deeper  |              31.013 |  0.0163 |   8.50 / 8.52 |     118.92 |           6,011.58 |  0.0074 |
|    2 | QQQ  | Deeper  |              20.471 |  0.0330 | 11.29 / 11.33 |     169.51 |           2,872.45 |  0.0196 |
|    3 | IWM  | Deeper  |               6.136 |  0.1248 | 12.11 / 12.24 |     153.99 |             956.85 |  0.0583 |
|    4 | TLT  | Deeper  |               2.479 |  0.1664 |   5.57 / 5.66 |     117.61 |             368.48 |  0.0739 |
|    5 | GLD  | Deeper  |               2.265 |  0.2668 |   8.95 / 8.95 |     223.33 |             274.82 |  0.1128 |
|    6 | XLF  | Deeper  |               1.681 |  0.3799 |   9.52 / 9.62 |     116.07 |             344.39 |  0.1586 |
|    7 | SMH  | Middle  |               2.083 |  0.6148 | 19.00 / 19.34 |     368.70 |             353.60 |  0.2803 |
|    8 | XLV  | Middle  |               1.288 |  0.4709 |   8.79 / 8.99 |     114.35 |             224.88 |  0.2295 |
|    9 | XLE  | Middle  |               1.370 |  0.6188 | 12.67 / 12.82 |     172.56 |             255.36 |  0.2732 |
|   10 | XLI  | Middle  |               1.194 |  0.5448 |   9.46 / 9.65 |     122.83 |             212.36 |  0.2423 |
|   11 | XLK  | Middle  |               1.308 |  0.7100 | 13.29 / 13.54 |     231.31 |             241.25 |  0.3114 |
|   12 | IEF  | Thinner |               0.628 |  0.4070 |   2.50 / 2.57 |      61.12 |              90.54 |  0.1468 |
|   13 | XBI  | Thinner |               0.907 |  1.3533 | 16.60 / 16.88 |     187.58 |             148.40 |  0.5826 |
|   14 | XLY  | Thinner |               0.761 |  1.0268 | 10.40 / 10.66 |     171.56 |             163.96 |  0.3977 |
|   15 | ARKK | Thinner |               0.518 |  3.2331 | 20.26 / 20.80 |     296.05 |              75.70 |  1.3744 |
|   16 | USO  | Thinner |               0.310 |  4.0822 | 17.75 / 17.87 |     405.86 |              34.01 |  1.6786 |

At 1 minute, SPY, QQQ, IWM and SMH ranked in that order. The final half hour still had the lowest Amihud
for all four. QQQ's 09:30 window tied 15:30 on the combined score and won the dollar-volume tiebreaker
($2,878.94m vs. $2,872.60m). The other three ranked the final half hour first. Amihud and volatility depend
on bar length, so compare ranks within a tape rather than comparing their magnitudes across resolutions.

## Measurement rules

- **Dollar volume:** sum `VWAP × shares` over each complete session or 30-minute window, then take the median
  of those totals. Partial windows contribute no dollar-volume total. A complete early-close session counts
  for the daily median, but no windows at or after 13:00 ET are expected for it.
- **Bar volatility:** for each admitted bar let `R = ln(high / low)` and `C = ln(close / open)`.
  [Garman–Klass](https://www-2.rotman.utoronto.ca/~kan/3032/pdf/FinancialAssetReturns/Garman_Klass_JB_1980.pdf)
  variance is `R² / 2 − (2 ln 2 − 1) × C²`; [Parkinson](https://www.cmegroup.com/trading/fx/files/michael_parkinson.pdf)
  variance is `R² / (4 ln 2)`. Report `10,000 × sqrt(mean(variance))` over observed native bars, not a 30-minute
  or annualized volatility estimate.
- **Amihud:** adapt the [daily return-to-volume ratio](https://www.cis.upenn.edu/~mkearns/finread/amihud.pdf)
  to bars. Take the arithmetic mean of `10,000 × abs(close / prior close − 1) / (bar USD volume / 1,000,000)` over
  adjacent bars in the same session, assigned to the later bar's window. No return crosses a missing slot
  or the open. A window without a volume median or eligible return pair is unranked.
- **Opening gap:** `10,000 × (opening bar open / previous session's closing bar close − 1)` only when both
  exact endpoints exist on consecutive calendar sessions. This is a 09:30-only observation. Signed p05,
  p25, median, p75, p95 and absolute median/p95 use linear interpolation. Prices are split-adjusted, not
  total-return adjusted. The gap is not a fill, and can include non-split corporate-action effects.

Every result retains observed/expected bars, complete volume observations and Amihud pairs for the session and
each window. For all 83 symbol/resolution profiles, `symbols[].buckets` follows `rthBuckets` in order and the
opening distribution is `symbols[].gapAtOpen`.

## Reproduce

From the repository root with read-only access to the existing S3 archive:

```sh
set -e
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
bun services/bayn/tools/profile-intraday-liquidity.ts > "$out/results.json"
bunx oxfmt "$out/results.json"
cmp "$out/results.json" docs/bayn/evidence/2026-11-28-intraday-liquidity-profile/results.json
```

Two S3 runs produced the same formatted bytes (SHA-256
`2e11d9f05a632853cd712b9a2ad8fbcd4ace67404e946eb7b597a886c7a5267f`). A separate calculation on the
verified TSVs also reproduced the coverage, all 83 symbol/resolution profiles and all 20 ETF rankings.
The profiler emits JSON to stdout only after verification. It does not write to the archive or any local
file, and has no broker, strategy, or order path.
