# Bayn Wave 1F: portfolio allocation

**Decision: no promotion.** Volatility targeting improved Sharpe, Calmar and ex-top-five net at both 5 and 10 bp
on matched live-universe sessions. At 10 bp, removing AVGO turned its ex-top-five net from **+$1,204.17** to
**−$2,701.40**, and removing the five best days separately within each live fold left that fold negative. No
sizing arm survived the longer ORB/Noise check and all the [frozen gates](protocol.md). Keep the primitives
available for unbound Wave 2 research, not as a policy or a source of trading authority. The live v2 hash and
migrations 0222/0223 are unchanged.

[Results](results.json) contains unrounded measurements, the trial registry and gate outcomes, input receipts,
dated daily net arrays, three folds, four regime slices, sleeve attribution, every candidate omission,
bootstrap distributions, DSR, and gross-use histograms. A daily `null` means unknown, not zero.

## Live universe: OOS portfolio economics

All monetary columns are USD on $100,000 fixed session equity. Sharpe annualizes daily net P&L with 252 sessions.
Calmar divides linear annualized fixed-notional return by maximum peak-to-trough daily equity drawdown (no
reinvestment); intraday marked drawdown is separate in JSON. The 2 and 5 bp rows use 65 matched sessions:
2026-11-17 had a missing concurrent position mark at an otherwise eligible entry. The 10 bp path did not hold
that position at the checkpoint and all 66 sessions were evaluable. The 65-session statistics are conditional
diagnostics, not an estimate of full-window net. BootP is the centered one-sided test against zero mean; the
uncentered circular 5-session bootstrap (10,000 trials) gives the net and drawdown quantiles. The block clock is
the matched sequence where coverage is incomplete. [DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
uses the daily Sharpe distribution across registered arms at each cost; it is not independent confirmation,
and the arms are correlated.

| RT bp | Arm                  |       Net | Sharpe |  Calmar |   MaxDD | Ex-top-5 | Ex-worst-5 |  BootP |    DSR |
| ----: | :------------------- | --------: | -----: | ------: | ------: | -------: | ---------: | -----: | -----: |
|     2 | v2-static            | 15,099.48 | 4.9414 | 42.4066 | 1.3804% | 5,566.61 |  19,469.51 | 0.0020 | 0.9971 |
|     2 | volatility           | 15,208.35 | 5.3549 | 42.7124 | 1.3804% | 6,018.99 |  18,982.80 | 0.0007 | 0.9988 |
|     2 | dispersion           | 15,968.41 | 4.7884 | 36.5447 | 1.6940% | 5,589.56 |  21,081.42 | 0.0034 | 0.9953 |
|     2 | inverse-vol          | 14,052.79 | 4.6120 | 38.7409 | 1.4063% | 4,304.88 |  18,527.28 | 0.0028 | 0.9956 |
|     2 | erc                  | 13,752.32 | 4.5173 | 38.5900 | 1.3816% | 4,075.00 |  18,333.31 | 0.0033 | 0.9942 |
|     2 | vol-dispersion       | 16,082.47 | 5.1722 | 40.1737 | 1.5520% | 5,928.28 |  20,619.59 | 0.0017 | 0.9978 |
|     2 | combined             | 14,816.47 | 4.9102 | 39.0598 | 1.4706% | 4,989.65 |  18,956.45 | 0.0025 | 0.9972 |
|     2 | combined-loss        | 14,816.47 | 4.9102 | 39.0598 | 1.4706% | 4,989.65 |  18,956.45 | 0.0025 | 0.9972 |
|     2 | combined-profit-lock | 14,197.25 | 4.9222 | 37.4274 | 1.4706% | 4,989.65 |  18,337.22 | 0.0027 | 0.9963 |
|     2 | combined-cap-120k    | 14,287.05 | 4.8788 | 37.6642 | 1.4706% | 4,870.54 |  18,427.03 | 0.0019 | 0.9965 |
|     5 | v2-static            | 13,058.65 | 4.2983 | 34.9117 | 1.4502% | 3,743.95 |  17,585.05 | 0.0045 | 0.9899 |
|     5 | volatility           | 13,377.37 | 4.7329 | 35.7638 | 1.4502% | 4,387.27 |  17,302.41 | 0.0024 | 0.9953 |
|     5 | dispersion           | 13,856.54 | 4.1818 | 30.3308 | 1.7712% | 3,718.10 |  19,166.93 | 0.0091 | 0.9861 |
|     5 | inverse-vol          | 12,038.06 | 3.9735 | 30.8693 | 1.5119% | 2,500.89 |  16,666.08 | 0.0080 | 0.9851 |
|     5 | erc                  | 11,740.86 | 3.8777 | 30.4629 | 1.4942% | 2,271.62 |  16,472.50 | 0.0095 | 0.9815 |
|     5 | vol-dispersion       | 14,187.50 | 4.5906 | 32.7451 | 1.6798% | 4,259.75 |  18,897.59 | 0.0058 | 0.9930 |
|     5 | combined             | 12,985.70 | 4.3281 | 31.3064 | 1.6081% | 3,355.17 |  17,264.98 | 0.0057 | 0.9909 |
|     5 | combined-loss        | 12,985.70 | 4.3281 | 31.3064 | 1.6081% | 3,355.17 |  17,264.98 | 0.0057 | 0.9909 |
|     5 | combined-profit-lock | 12,374.69 | 4.3141 | 29.8333 | 1.6081% | 3,355.17 |  16,653.96 | 0.0064 | 0.9886 |
|     5 | combined-cap-120k    | 12,469.42 | 4.2795 | 30.0617 | 1.6081% | 3,239.47 |  16,748.70 | 0.0053 | 0.9891 |
|    10 | v2-static            |  8,520.35 | 2.9846 | 16.8889 | 1.9262% |   388.62 |  13,222.49 | 0.0293 | 0.9227 |
|    10 | volatility           |  9,253.19 | 3.4104 | 20.1202 | 1.7560% | 1,204.17 |  13,449.08 | 0.0162 | 0.9538 |
|    10 | dispersion           |  9,249.72 | 2.9849 | 14.4076 | 2.4513% |   332.28 |  14,662.75 | 0.0375 | 0.9222 |
|    10 | inverse-vol          |  7,477.96 | 2.6807 | 12.7367 | 2.2417% |  -651.91 |  12,282.21 | 0.0395 | 0.8947 |
|    10 | erc                  |  7,196.91 | 2.5775 | 11.8699 | 2.3150% |  -868.71 |  12,168.21 | 0.0437 | 0.8823 |
|    10 | vol-dispersion       | 10,014.20 | 3.4006 | 18.6905 | 2.0457% | 1,073.79 |  15,031.38 | 0.0212 | 0.9528 |
|    10 | combined             |  8,752.03 | 3.0970 | 14.4499 | 2.3126% |   249.23 |  13,288.68 | 0.0246 | 0.9347 |
|    10 | combined-loss        |  8,752.03 | 3.0970 | 14.4499 | 2.3126% |   249.23 |  13,288.68 | 0.0246 | 0.9347 |
|    10 | combined-profit-lock |  8,752.03 | 3.0970 | 14.4499 | 2.3126% |   249.23 |  13,288.68 | 0.0246 | 0.9347 |
|    10 | combined-cap-120k    |  8,257.64 | 3.0172 | 13.6199 | 2.3149% |   139.22 |  12,794.30 | 0.0260 | 0.9253 |

### Walk-forward and stress results

The live extract has **no SPY minute bars before Aug 24**, and Aug 24 has only a partial tape. There are no
complete three-sleeve warmup P&Ls; the first fold has no fitted sleeve vol targets. Dispersion histories also
need 14 usable readings at the same clock minute. The adaptive selector stayed on v2 static for all three
folds, using 0 / 22 / 44 matched past sessions (the first was a fallback, not a fitted choice). An isolated
fixed arm can outperform in hindsight without being selected prospectively.

| Forward fold  | Static 5 bp net | Vol 5 bp net | Static 10 bp net | Vol 10 bp net | Vol 10 bp ex-top-5 |
| :------------ | --------------: | -----------: | ---------------: | ------------: | -----------------: |
| Aug 25–Sep 24 |        1,477.00 |     1,477.00 |           178.04 |        178.04 |          −4,381.61 |
| Sep 25–Oct 26 |        3,631.64 |     4,213.55 |         2,750.34 |      3,470.25 |          −1,048.42 |
| Oct 27–Nov 25 |        7,950.02 |     7,686.83 |         5,591.97 |      5,604.89 |          −1,161.27 |

- **Tail and LOSO:** At 10 bp, ex-top-five stayed positive for 12/20 omissions under static sizing, 15/20 for
  volatility, 15/20 for vol-dispersion and 14/20 for combined. At 5 bp, volatility's 20/20 is conditional on
  incomplete coverage, not a promotion pass. LOSO reselects entries, refits priors and reruns portfolio
  occupancy and capacity; it does not subtract the omitted symbol's historical P&L.
- **Regimes:** At 10 bp, volatility net was $2,838.19 on up-SPY days and $6,415.00 on down/flat-SPY days.
  It earned $8,424.57 in high volatility versus $828.62 in low volatility; ex-best-five was negative in the
  low-vol slice (−$3,660.66). Direction is classified from same-day SIP close-to-close SPY returns; high vol means
  prior-14-session SPY volatility exceeds the median of the prior 60 such estimates. Neither label sizes a trade.
- **Bootstrap:** At 10 bp, volatility's bootstrapped fifth-percentile net was $2,268.54 (static $1,213.84),
  and its 95th-percentile MaxDD was 3.7679% (static 4.3222%). Neither result resolves sign reversals under LOSO.
- **Plateau:** The combined arm's four ±10% target/slope neighbors had positive matched ex-top-five net at
  5 bp ($3,193.88–$3,488.59) and 10 bp ($143.40–$355.69). That narrow result did not translate to a Calmar
  improvement; inverse-vol and ERC on their own both went negative ex-top-five at 10 bp.
- **Circuit breakers:** The 1.5% drawdown rule did not resize a live-cohort entry. The profit lock resized one
  entry at 2 and 5 bp, reduced net, and did not reduce MaxDD. The $120k admission variant reduced net and did not
  reduce end-of-day MaxDD at 5 or 10 bp; market marks drifted briefly over its tighter cap on one day.

### Gross headroom

There were **zero admissions or sampled market marks over $180k**. At 5 bp, static peaked at $121,504.49
marked gross; across all live trials the highest mark was $153,999.74, leaving $26,000.26 of account headroom.
The 5 bp session-peak histograms below include open and close marks plus pre-fill reservations. The JSON also
reports bar-close exposure time and cap drift. Buckets are relative to each arm's admission cap; off-market
rounding/price risk is not evidence of intraminute cap enforcement.

| Arm             | No gross | >0–20% | >20–40% | >40–60% | >60–80% | >80% |
| :-------------- | -------: | -----: | ------: | ------: | ------: | ---: |
| Static          |        0 |      0 |      24 |      25 |      17 |    0 |
| Volatility      |        0 |      0 |      28 |      30 |       8 |    0 |
| Combined        |        0 |      1 |      38 |      22 |       4 |    1 |
| Combined, $120k |        0 |      0 |      11 |      28 |      14 |   13 |

## 2024–26 ORB + Noise Area

This is a distinct reduced-universe stress check, not a backfilled full-portfolio return. AAPL, AMZN and NVDA
are the ORB universe; QQQ and SMH are the Noise Area universe; SPY is the benchmark. The historical file
supplies decisions through 2026-08-24, and the live file supplies the splice starting 2026-08-25. Pre-June-10
2024 NVDA OHLC/VWAP is divided by 10 and volume multiplied by 10. The development, validation and frozen
holdout contain 374, 189 and 166 calendar sessions; common support is 286, 185 and 166 respectively. The
incomplete paths include starting baseline warmup, missing benchmark checkpoints and missing co-held marks.
The holdout is complete but includes the live splice; it is not an independent repeat of the 66-day study.

| RT bp | Arm        |  Train net | Validation net | Holdout net | Holdout ex-top-5 | 637-session Sharpe | 637-session Calmar | 637-session MaxDD |
| ----: | :--------- | ---------: | -------------: | ----------: | ---------------: | -----------------: | -----------------: | ----------------: |
|     2 | v2-static  |  -2,577.73 |       1,029.63 |    5,533.40 |          -445.40 |             0.2796 |             0.2512 |           6.2755% |
|     2 | volatility |  -2,855.75 |         -51.63 |    5,718.35 |           290.70 |             0.2056 |             0.1788 |           6.2205% |
|     5 | v2-static  |  -7,077.38 |      -2,146.50 |    2,526.44 |        -3,333.99 |            -0.4713 |            -0.2071 |          12.7952% |
|     5 | volatility |  -7,241.29 |      -2,994.17 |    2,879.79 |        -2,415.14 |            -0.5388 |            -0.2277 |          12.7792% |
|    10 | v2-static  | -13,688.22 |      -6,463.01 |   -2,126.58 |        -6,950.49 |            -1.6697 |            -0.3708 |          23.7656% |
|    10 | volatility | -13,701.89 |      -6,992.27 |   -1,471.76 |        -5,910.24 |            -1.7187 |            -0.3777 |          23.2173% |

At 5 bp on matched long-history sessions, static ORB lost $10,626.14 and Noise Area earned $3,928.70 before
removing the five best Noise Area days (after removal: −$5,018.85). At 10 bp both sleeves were negative.
Two-sleeve inverse-volatility and ERC coincide mathematically, and their observed size paths coincide here.
No variant had positive ex-top-five net in **both** validation and holdout at 5 or 10 bp.

## What the replay measures

- The control and candidates share v2 phase priority, eligibility and ranking, stops/targets, and holding
  windows. The control uses the v2 static sleeve weights, not a replay of live account mutations.
- The research clock observes a completed 1m bar, reserves whole-share orders against its close-based collar,
  then proxies execution at the next bar's open if inside the modeled limit and reservation. Both sides of
  a basket can fill independently. The model skips the signal-only single-leg Midday fallback. Timed exits
  use the first subsequent open; stop wins an ambiguous stop/target bar, and a gap through the stop-limit
  remains working until the tape provides a price or the timed exit takes over. This is not the production
  target planner, does not model routing/queue/latency/borrow rejections, and cannot certify a live fill.
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
