# Bayn Wave 1F: portfolio allocation

**Decision: no promotion.** Volatility plus dispersion improved matched-session Sharpe and Calmar at both
5 and 10 bp, but every arm lost money after removing its five best days at those costs. At 10 bp, the
vol-dispersion arm's **+$3,825.61** became **−$4,606.52** after removal and **−$7,863.33** when AVGO was
also excluded and the portfolio was retrained. No sizing arm passed the longer ORB/Noise stress check or all
the [frozen gates](protocol.md). Keep the primitives unbound for Wave 2 research; the live v2 hash and migrations
0222/0223 are unchanged.

[Results](results.json) contains unrounded measurements, the trial registry and gate outcomes, input receipts,
dated daily net arrays, three folds, four regime slices, sleeve attribution, every candidate omission,
bootstrap distributions, DSR, and gross-use histograms. A daily `null` means unknown, not zero.

## Live universe: OOS portfolio economics

All monetary columns are USD on $100,000 fixed session equity. Sharpe annualizes daily net P&L with 252 sessions.
Calmar divides linear annualized fixed-notional return by maximum peak-to-trough daily equity drawdown (no
reinvestment); intraday marked drawdown is separate in JSON. All cost rows use 65 matched sessions out of
66: on 2026-11-17 a concurrent position mark was missing at an otherwise eligible entry. The 65-session
statistics are conditional diagnostics, not an estimate of full-window net. BootP is the centered one-sided test against zero mean; the
uncentered circular 5-session bootstrap (10,000 trials) gives the net and drawdown quantiles. The block clock is
the matched sequence where coverage is incomplete. [DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
uses the daily Sharpe distribution across registered arms at each cost; it is not independent confirmation,
and the arms are correlated.

| RT bp | Arm                  |      Net |  Sharpe |  Calmar |   MaxDD |  Ex-top-5 | Ex-worst-5 |  BootP |    DSR |
| ----: | :------------------- | -------: | ------: | ------: | ------: | --------: | ---------: | -----: | -----: |
|     2 | v2-static            | 6,835.33 |  2.8569 | 15.4802 | 1.7119% |   -538.14 |  11,208.88 | 0.0601 | 0.8935 |
|     2 | volatility           | 7,731.02 |  3.0340 | 19.3781 | 1.5467% |   -471.36 |  12,131.79 | 0.0474 | 0.9210 |
|     2 | dispersion           | 8,490.34 |  3.2743 | 17.5069 | 1.8802% |    748.74 |  13,002.16 | 0.0399 | 0.9296 |
|     2 | inverse-vol          | 5,047.45 |  2.2574 | 10.8512 | 1.8034% | -1,835.58 |   9,349.03 | 0.0797 | 0.8204 |
|     2 | erc                  | 4,929.74 |  2.2295 | 10.3844 | 1.8405% | -1,879.92 |   9,194.85 | 0.0824 | 0.8160 |
|     2 | vol-dispersion       | 9,179.96 |  3.4032 | 20.6689 | 1.7219% |    563.77 |  13,759.23 | 0.0326 | 0.9455 |
|     2 | combined             | 6,996.15 |  2.8876 | 16.5015 | 1.6437% |   -767.18 |  11,075.14 | 0.0430 | 0.9041 |
|     2 | combined-loss        | 6,996.15 |  2.8876 | 16.5015 | 1.6437% |   -767.18 |  11,075.14 | 0.0430 | 0.9041 |
|     2 | combined-profit-lock | 6,996.15 |  2.8876 | 16.5015 | 1.6437% |   -767.18 |  11,075.14 | 0.0430 | 0.9041 |
|     2 | combined-cap-120k    | 7,046.74 |  2.9079 | 16.6381 | 1.6420% |   -716.59 |  11,124.76 | 0.0419 | 0.9061 |
|     5 | v2-static            | 3,804.19 |  1.5219 |  4.8018 | 3.0715% | -3,953.04 |   8,316.55 | 0.2102 | 0.7237 |
|     5 | volatility           | 4,752.39 |  1.7269 |  6.2286 | 2.9581% | -4,112.47 |   9,271.15 | 0.1781 | 0.7717 |
|     5 | dispersion           | 4,884.87 |  1.8678 |  5.8656 | 3.2287% | -3,208.10 |   9,438.16 | 0.1662 | 0.7828 |
|     5 | inverse-vol          | 2,636.55 |  1.1374 |  3.9120 | 2.6129% | -4,561.67 |   7,057.95 | 0.2410 | 0.6489 |
|     5 | erc                  | 2,511.68 |  1.1018 |  3.6752 | 2.6495% | -4,563.80 |   6,894.68 | 0.2491 | 0.6414 |
|     5 | vol-dispersion       | 5,640.10 |  2.0071 |  6.8301 | 3.2014% | -3,563.99 |  10,270.71 | 0.1450 | 0.8159 |
|     5 | combined             | 3,994.01 |  1.6177 |  6.1476 | 2.5188% | -4,232.19 |   8,191.86 | 0.1686 | 0.7456 |
|     5 | combined-loss        | 3,994.01 |  1.6177 |  6.1476 | 2.5188% | -4,232.19 |   8,191.86 | 0.1686 | 0.7456 |
|     5 | combined-profit-lock | 3,994.01 |  1.6177 |  6.1476 | 2.5188% | -4,232.19 |   8,191.86 | 0.1686 | 0.7456 |
|     5 | combined-cap-120k    | 4,049.10 |  1.6397 |  6.2418 | 2.5150% | -4,177.10 |   8,244.32 | 0.1658 | 0.7496 |
|    10 | v2-static            | 1,417.91 |  0.5937 |  1.5970 | 3.4422% | -5,660.52 |   5,731.23 | 0.3471 | 0.4880 |
|    10 | volatility           | 3,200.12 |  1.2171 |  4.2142 | 2.9440% | -4,907.44 |   7,528.20 | 0.2321 | 0.6217 |
|    10 | dispersion           | 2,189.52 |  0.8834 |  2.4394 | 3.4799% | -5,490.17 |   6,498.09 | 0.2936 | 0.5480 |
|    10 | inverse-vol          |   149.25 |  0.0678 |  0.1579 | 3.6657% | -6,669.76 |   4,285.11 | 0.4711 | 0.3839 |
|    10 | erc                  |   -31.47 | -0.0145 | -0.0334 | 3.6581% | -6,710.01 |   4,062.77 | 0.4917 | 0.3686 |
|    10 | vol-dispersion       | 3,825.61 |  1.4330 |  5.1158 | 2.8992% | -4,606.52 |   8,224.15 | 0.2017 | 0.6657 |
|    10 | combined             | 1,954.00 |  0.8461 |  2.5290 | 2.9955% | -5,472.30 |   5,864.68 | 0.2823 | 0.5409 |
|    10 | combined-loss        | 1,954.00 |  0.8461 |  2.5290 | 2.9955% | -5,472.30 |   5,864.68 | 0.2823 | 0.5409 |
|    10 | combined-profit-lock | 1,954.00 |  0.8461 |  2.5290 | 2.9955% | -5,472.30 |   5,864.68 | 0.2823 | 0.5409 |
|    10 | combined-cap-120k    | 2,019.53 |  0.8742 |  2.6155 | 2.9936% | -5,406.76 |   5,924.82 | 0.2779 | 0.5468 |

### Walk-forward and stress results

The live extract has **no SPY minute bars before Aug 24**, and Aug 24 has only a partial tape. There are no
complete three-sleeve warmup P&Ls; the first fold has no fitted sleeve vol targets. Dispersion histories also
need 14 usable readings at the same clock minute. The adaptive selector stayed on v2 static for all three
folds, using 0 / 22 / 44 matched past sessions (the first was a fallback, not a fitted choice). An isolated
fixed arm can outperform in hindsight without being selected prospectively.

| Forward fold  | Static 5 bp net | Vol-dispersion 5 bp net | Static 10 bp net | Vol-dispersion 10 bp net | Vol-dispersion 10 bp ex-top-5 |
| :------------ | --------------: | ----------------------: | ---------------: | -----------------------: | ----------------------------: |
| Aug 25–Sep 24 |         −326.89 |                 −258.34 |        −1,342.52 |                −1,171.85 |                     −3,391.40 |
| Sep 25–Oct 26 |        2,027.68 |                2,714.10 |         1,192.11 |                 1,860.70 |                     −1,639.45 |
| Oct 27–Nov 25 |        2,103.40 |                3,184.35 |         1,568.31 |                 3,136.75 |                     −4,601.74 |

- **Tail and LOSO:** Static, volatility, vol-dispersion and combined had **0/20** omissions with positive
  ex-top-five net at either 5 or 10 bp. AVGO was the worst omission for all four. LOSO reselects entries, refits
  priors and reruns portfolio occupancy and capacity; it does not just subtract the omitted symbol's P&L.
- **Regimes:** At 10 bp, vol-dispersion net was $1,489.00 on up-SPY days and $2,336.61 on down/flat-SPY days.
  It earned $4,055.68 in high volatility and lost $230.07 in low volatility. Ex-top-five net was negative in
  every regime. Direction comes from same-day SIP close-to-close SPY returns; high vol means prior-14-session
  SPY volatility exceeds the median of the prior 60 such estimates. Neither label sizes a trade.
- **Bootstrap:** At 10 bp, vol-dispersion's bootstrapped fifth-percentile net was −$3,477.40 (static −$5,132.19),
  and its 95th-percentile MaxDD was 6.0478% (static 7.1323%). BootP of 0.2017 and DSR of 0.6657 did not clear the
  gates. Even a better matched point estimate does not establish a repeatable improvement.
- **Plateau:** The combined arm's four ±10% target/slope neighbors all failed the tail test: matched ex-top-five
  net was −$4,203.43 to −$4,012.16 at 5 bp and −$5,494.65 to −$5,223.20 at 10 bp. Pure ERC had negative net
  at 10 bp even before removal.
- **Circuit breakers:** Neither the 1.5% drawdown throttle nor the profit lock resized a live-cohort entry.
  The $120k variant improved matched net by about $55 at 5 bp and $66 at 10 bp, but had little effect on
  daily MaxDD, remained tail-fragile and drifted above its tighter cap on one day at 2/5 bp.

### Gross headroom

There were **zero admissions or sampled market marks over $180k**. At 5 bp, static peaked at $120,446.92
marked gross; across all live trials the highest mark was $162,320.04, leaving about $17,680 of account
headroom. The 5 bp session-peak histograms include open and close marks plus pre-fill reservations; the JSON
also reports bar-close exposure time and cap drift. Buckets are relative to each arm's admission cap.
Bar-level prices do not establish intraminute cap enforcement.

| Arm             | No gross | >0–20% | >20–40% | >40–60% | >60–80% | >80% |
| :-------------- | -------: | -----: | ------: | ------: | ------: | ---: |
| Static          |        0 |      2 |      33 |      22 |       9 |    0 |
| Volatility      |        0 |      3 |      34 |      18 |      11 |    0 |
| Vol-dispersion  |        0 |      3 |      25 |      26 |       8 |    4 |
| Combined        |        0 |      4 |      40 |      14 |       8 |    0 |
| Combined, $120k |        0 |      0 |      16 |      28 |      10 |   12 |

## 2024–26 ORB + Noise Area

This is a distinct reduced-universe stress check, not a backfilled full-portfolio return. AAPL, AMZN and NVDA
are the ORB universe; QQQ and SMH are the Noise Area universe; SPY is the benchmark. The historical file
supplies decisions through 2026-08-24, and the live file supplies the splice starting 2026-08-25. Pre-June-10
2024 NVDA OHLC/VWAP is divided by 10 and volume multiplied by 10. The development, validation and frozen
holdout contain 374, 189 and 166 calendar sessions; common support is 284, 186 and 166 at 2/5 bp and 285, 186 and 166 at 10 bp. The
incomplete paths include starting baseline warmup, missing benchmark checkpoints and missing co-held marks.
The holdout is complete but includes the live splice; it is not an independent repeat of the 66-day study.

| RT bp | Arm        | Train net | Validation net | Holdout net | Holdout ex-top-5 | Matched Sharpe | Matched Calmar | Matched MaxDD |
| ----: | :--------- | --------: | -------------: | ----------: | ---------------: | -------------: | -------------: | ------------: |
|     2 | v2-static  |  1,848.20 |         342.54 |   -1,293.67 |        -5,012.23 |         0.0747 |         0.0710 |       5.0044% |
|     2 | volatility |  1,037.55 |      -1,306.82 |     -546.02 |        -4,402.22 |        -0.0707 |        -0.0541 |       5.9748% |
|     5 | v2-static  |   -312.12 |      -2,432.43 |   -3,348.68 |        -6,782.98 |        -0.5114 |        -0.3226 |       7.4848% |
|     5 | volatility |   -961.51 |      -3,979.10 |   -2,439.72 |        -6,093.65 |        -0.6462 |        -0.3644 |       8.0241% |
|    10 | v2-static  | -4,093.84 |      -5,890.84 |   -4,473.37 |        -8,267.01 |        -1.2238 |        -0.3907 |      14.6394% |
|    10 | volatility | -4,650.77 |      -6,904.54 |   -3,197.17 |        -7,369.11 |        -1.2909 |        -0.3908 |      14.9332% |

At 5 bp on matched long-history sessions, static ORB lost $5,381.65 and Noise Area lost $711.57. At 10 bp
both were also negative (−$9,435.77 and −$5,022.29 respectively). Two-sleeve inverse-volatility and ERC
coincide mathematically, and their observed size paths coincide here. No variant had positive ex-top-five
net in both validation and holdout at 5 or 10 bp.

## What the replay measures

- The control and candidates share v2 phase priority, eligibility and ranking, stops/targets, and holding
  windows. The control uses the v2 static sleeve weights, not a replay of live account mutations.
- The research clock uses completed 1m bars and v2's two-second observation delay. It reserves whole-share
  orders against the completed close and admits only an open strictly after the observation and strictly
  before the one-minute working window expires. The open on the completed bar's boundary precedes the
  observation and cannot fill. While that order is working, the completed-bar loop does not admit another.
  Both sides can fill independently, and the v2 single-leg Midday fallback is retained. Timed exits use
  the first subsequent open; stop wins an ambiguous stop/target bar, and a gap through the stop-limit remains
  working until the tape provides a price or the timed exit takes over. This is not the production target
  planner, does not model routing/queue or borrow rejections, and cannot certify a live fill.
- The execution model applies half of 2/5/10 bp on each side and 0.21 bp on sell notional. The exit slippage is
  an economic haircut even for modeled target exits. IEX-wide quote spreads, including thin mid-cap Semis
  spreads, do not enter the cost model. This follows the consolidated NBBO scenario choice in
  [Wave 1A](https://github.com/proompteng/lab/pull/16352), not a claim that future NBBO fills are guaranteed.
- Volatility targeting is an inverse-_volatility_ adaptation of [Moreira and Muir](https://doi.org/10.1111/jofi.12513),
  who studied inverse variance. The [Nagel](https://doi.org/10.1093/rfs/hhs066)-inspired sizing variable is
  cross-sectional VWAP-deviation standard deviation, not the VIX variable in his paper. It is compared to
  its own trailing same-checkpoint median only after the decision bar completes. ERC uses aligned 14-session
  static shadow returns and shrinks off-diagonal covariance by 50%; caps and realized fills may alter risk
  contributions. A missing prior return or insufficient history leaves the affected adjustment neutral.
- Fixed account sizing uses the requested v6 sandbox envelope ($180k gross, 4× intraday buying power, $40k
  per order/symbol and $100k directional net). It does not reproduce persistent production or sandbox
  reconciliation, loss, drawdown, or rollover enforcement. Only the research overlays affect afternoon sizing.

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

The runner verifies the manifest hash, object sizes, gzip and raw SHA-256 checksums and minute row counts before
scoring. No downloaded object belongs in Git. Reconsider sizing only after an independent complete live-universe
sample with executable NBBO and borrow/arrival evidence holds up to the same tail and omission stresses.
