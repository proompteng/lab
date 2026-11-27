# Bayn Wave 1F: portfolio allocation

**Decision: no promotion.** The frozen live-universe tape supports only **3 of 66 matched sessions at 2/5 bp
and 4 of 66 at 10 bp** after requiring execution evidence. This is not enough to validate a 14-session
risk target, a live 5-day bootstrap, or ex-top-five profitability. The separate 2024–26 ORB/Noise Area
stress is also negative at 5 and 10 bp, including after removing the five best days. Keep the allocator
primitives unbound for Wave 2 research. The live v2 hash, migrations 0222/0223, and capital authority are unchanged.

[Results](results.json) retains exact matched estimates, nullable daily paths, input hashes, all arms and gate
decisions, folds, regimes, leave-one-symbol-out runs, bootstrap distributions, DSR, and gross headroom.
The [protocol](protocol.md) defines promotion. A missing input produces an unknown return, not zero.

## Why the tape cannot qualify the allocator

A 1m IEX bar gap does not prove an NBBO-routed order missed a fill or that an open position did not touch
its stop or target. At 5 bp the static path saw **6 missing eligible entry opens** and **1,913 missing held-bar
observations** across modeled positions. Neither a later price nor another symbol's tape repairs those gaps.
The replay invalidates the daily portfolio and shadow returns and stops admitting risk when the execution
path becomes unknown. Observed collar rejections remain known non-fills.

There are no SPY minute bars in the live extract before Aug 24, and Aug 24 is partial. The prospective selector
had 0 / 0 / 1 complete prior sessions at the three fold boundaries and retained static sizing each time.
No fold had a fitted volatility target. VWAP dispersion can still be observed at some eligible checkpoints,
so its modifier can differ. Identical parity, volatility and static results on matched days do **not** mean
these allocators are equivalent on a complete tape.

### Live diagnostics, not full-window results

Dollar amounts use fixed $100,000 opening equity each session. Sharpe annualizes daily net with 252 sessions.
Calmar divides linearly annualized fixed-notional return by daily maximum drawdown (no reinvestment).
These ratios are only arithmetic on three or four days; there is no positive-edge claim. A 5-session block
or best/worst-five subtraction is unavailable for all primary live arms; those fields are null.

| RT bp | Matched days | Arm                                    |   Net USD |   Sharpe |   Calmar |   MaxDD | DSR (diagnostic) |
| ----: | -----------: | :------------------------------------- | --------: | -------: | -------: | ------: | ---------------: |
|     2 |            3 | Static / vol / inverse-vol / ERC       |   -996.00 | -11.4645 | -73.1623 | 1.1435% |           0.1638 |
|     2 |            3 | Dispersion / vol-dispersion / combined |   -886.40 | -12.0696 | -74.7633 | 0.9959% |           0.1527 |
|     2 |            3 | Combined, $120k cap                    |   -912.64 | -12.3771 | -75.0025 | 1.0221% |           0.1535 |
|     5 |            3 | Static / vol / inverse-vol / ERC       | -1,063.47 | -12.0980 | -74.7370 | 1.1953% |           0.1500 |
|     5 |            3 | Dispersion / vol-dispersion / combined |   -957.52 | -12.9262 | -76.7006 | 1.0486% |           0.1371 |
|     5 |            3 | Combined, $120k cap                    |   -982.21 | -13.2064 | -76.8701 | 1.0733% |           0.1385 |
|    10 |            4 | Static / vol / inverse-vol / ERC       | -1,440.08 | -14.5631 | -63.0000 | 1.4401% |           0.0370 |
|    10 |            4 | Dispersion / vol-dispersion / combined | -1,472.30 | -17.9667 | -63.0000 | 1.4723% |           0.0414 |
|    10 |            4 | Combined, $120k cap                    | -1,494.41 | -18.1758 | -63.0000 | 1.4944% |           0.0431 |

| RT bp | Forward fold (22 requested) | Matched days | Static net USD | Vol-dispersion net USD |
| ----: | :-------------------------- | -----------: | -------------: | ---------------------: |
|     2 | 2026-08-25 to 2026-09-24    |            0 |    Unavailable |            Unavailable |
|     2 | 2026-09-25 to 2026-10-26    |            1 |         149.25 |                 110.61 |
|     2 | 2026-10-27 to 2026-11-25    |            2 |      -1,145.25 |                -997.02 |
|     5 | 2026-08-25 to 2026-09-24    |            0 |    Unavailable |            Unavailable |
|     5 | 2026-09-25 to 2026-10-26    |            1 |         133.40 |                  92.09 |
|     5 | 2026-10-27 to 2026-11-25    |            2 |      -1,196.87 |              -1,049.61 |
|    10 | 2026-08-25 to 2026-09-24    |            0 |    Unavailable |            Unavailable |
|    10 | 2026-09-25 to 2026-10-26    |            2 |        -157.17 |                -335.03 |
|    10 | 2026-10-27 to 2026-11-25    |            2 |      -1,282.91 |              -1,137.28 |

- **LOSO:** Rerank and rerun all 20 omissions, including calibration and occupancy; do not subtract a
  symbol's P&L. None of the omissions supported all 66 days. For static, volatility, vol-dispersion and
  combined, omission subpaths supported 3–8 days at 5 bp and 4–9 days at 10 bp. One omission at 5 bp and
  four at 10 bp supported ex-five statistics in each of these arms; none of those conditional tails was positive.
- **Regimes:** On the four 10 bp matched days, vol-dispersion net was −$346.56 for up-SPY and −$1,125.75
  for down/flat-SPY; −$1,137.28 in high vol and −$335.03 in low vol. These two-session slices are not regime
  validation. Direction uses same-day close-to-close SIP SPY returns; high vol means prior-14-session SPY
  volatility exceeds its prior 60-estimate median. Neither label sizes a trade.
- **Plateau and overlays:** No ±10% neighbor supports an ex-five conclusion at the target costs. The loss
  throttle and profit lock did not resize an evaluated live entry; the tighter cap can change reservations,
  but three or four days cannot establish a Calmar or upside improvement.

### Gross headroom

No admitted basket or supported sampled mark exceeded $180,000. Across live arms the largest known
reservation was **$151,394** and the highest supported gross mark was **$131,704**, rounded to dollars.
This does not certify exposure after gaps or between observations. At 5 bp, static withheld 15,783 minutes
from its mark-usage histogram. JSON separates unknown minutes from known flat time. Peak buckets use
known marks and admitted reservations relative to each arm's cap.

| Arm at 5 bp     | No gross | >0–20% | >20–40% | >40–60% | >60–80% | >80% |
| :-------------- | -------: | -----: | ------: | ------: | ------: | ---: |
| Static          |        0 |     12 |      41 |       9 |       4 |    0 |
| Volatility      |        0 |     12 |      41 |       9 |       4 |    0 |
| Vol-dispersion  |        0 |     12 |      28 |      19 |       6 |    1 |
| Combined        |        0 |     12 |      28 |      19 |       6 |    1 |
| Combined, $120k |        0 |      6 |       8 |      26 |       7 |   19 |

## 2024–26 ORB + Noise Area

This is a reduced-universe stress, not a backfilled three-sleeve portfolio. ORB trades AAPL, AMZN and NVDA;
Noise Area trades QQQ and SMH; SPY is the benchmark. Use the historical tape through 2026-08-24 and splice
the live tape from 2026-08-25. Divide pre-2024-06-10 NVDA OHLC/VWAP by 10 and multiply volume by 10.
The frozen development, validation and holdout have 374, 189 and 166 requested sessions. The splice overlaps
the shorter study and is not independent confirmation.

The registered long arms tie the static path on matched days. There is no fitted volatility target at either
out-of-sample boundary and no complete joint 14-session window to exercise parity on the measured path.
Midday is not backfilled. The table shows common matched portfolio estimates.

| RT bp | Matched train / validation / holdout | Train net USD | Validation net USD | Holdout net USD | Holdout ex-top-5 USD |  Sharpe |  Calmar |    MaxDD |  BootP |    DSR |
| ----: | :----------------------------------- | ------------: | -----------------: | --------------: | -------------------: | ------: | ------: | -------: | -----: | -----: |
|     2 | 141 / 103 / 91                       |     -1,868.45 |            -502.56 |       -3,209.58 |            -5,137.49 | -1.4479 | -0.7227 |  5.8088% | 0.9556 | 0.0530 |
|     5 | 143 / 105 / 95                       |     -1,450.36 |          -2,358.81 |       -4,470.79 |            -6,299.81 | -2.0664 | -0.7165 |  8.4904% | 0.9951 | 0.0108 |
|    10 | 152 / 108 / 98                       |     -2,784.92 |          -3,321.58 |       -4,128.86 |            -6,446.18 | -2.3896 | -0.6839 | 10.5344% | 0.9994 | 0.0058 |

At 10 bp, the matched static path lost $10,109.98 in ORB and $125.38 in Noise Area. Both lost more
after their own five best days were removed. The 10,000-trial circular 5-session bootstrap on 358 matched
sessions had a 5th–95th percentile net range of −$15,695.75 to −$4,644.93. BootP tests the centered null
of zero mean; the net and drawdown quantiles use uncentered draws. Blocks follow the matched sequence.
[Deflated Sharpe](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) adjusts for the trial registry and
skew/kurtosis; neither calculation supplies missing market evidence.

## Replay and allocator contracts

- The control and alternatives share the v2 phase priority, ranked signals, completed-close collar, single-leg
  Midday fallback, protective levels and holding windows. Orders reserve whole shares and fill only at an open
  strictly after the delayed observation and before its one-minute expiry. An observation at expiry can see
  the preceding order's open and inventory but not the next bar's close, high or low. Stop takes priority on
  ambiguous OHLC bars; a gap beyond the stop-limit can leave a working exit.
- A missing eligible open is not a collar rejection. A missing held bar cannot establish that a bracket
  survived. The replay withholds account and sleeve returns, keeps separately supported closed legs as
  diagnostics, and does not open new risk on an unknown path. It does not certify routing or borrow.
- Cost is 2/5/10 bp consolidated NBBO round trip (half each side) plus 0.21 bp on sell notional. Exit slippage
  is an economic haircut, even at a modeled target. IEX spreads are not a cost input; see
  [Wave 1A](https://github.com/proompteng/lab/pull/16352).
- The [Moreira–Muir](https://doi.org/10.1111/jofi.12513) adaptation uses inverse realized volatility, rather
  than inverse variance as in the paper. The [Nagel](https://doi.org/10.1093/rfs/hhs066)-inspired Midday
  multiplier uses the standard deviation of completed VWAP deviations against its own lagged checkpoint
  median, not VIX. ERC uses aligned 14-session static shadow returns and 50% off-diagonal shrinkage.
  Missing priors leave the affected sizing multiplier neutral.
- The sandbox v6 admission envelope is $180k absolute gross, 4× intraday buying power, $40k per order/symbol,
  and $100k directional net headroom. The study does not reproduce broker reconciliation, persistent risk
  kill switches or trading authority.

## Reproduce

From the repository root with the authorized `agents-artifacts` secret mounted in the environment:

```sh
frozen=$(mktemp -d)
trap 'find "$frozen" -depth -delete' EXIT
bun -e '
import { S3Client } from "bun"
const client = new S3Client({
  endpoint: process.env.AGENTS_ARTIFACTS_ENDPOINT || "http://rook-ceph-rgw-objectstore.rook-ceph.svc:80",
  bucket: process.env.AGENTS_ARTIFACTS_BUCKET || "agents-artifacts",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
})
for (const name of [
  "MANIFEST.json",
  "bars_1m_live_20260716_20261125.tsv.gz",
  "bars_1m_3yr_7sym_20240102_20260911.tsv.gz",
  "daily_sip_17sym_20160104_20261125.tsv.gz",
  "calendar_2024_2026.json",
]) await Bun.write(process.argv[1] + "/" + name, client.file("bayn-research-datasets/2026-11-27/" + name))
' "$frozen"
bun services/bayn/tools/research-portfolio-allocator.ts "$frozen" "$frozen/results.json"
bunx oxfmt --config .oxfmtrc.json "$frozen/results.json"
cmp "$frozen/results.json" docs/bayn/evidence/2026-11-27-portfolio-allocator/results.json
```

The runner verifies the manifest hash, object sizes, gzip and raw SHA-256 checksums, and minute row counts
before scoring. No downloaded object belongs in Git. A complete live-universe tape with executable NBBO
and borrow/arrival evidence is required before rerunning the qualification gates.
