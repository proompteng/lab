# Wave 9A: 10.9-year ETF overnight, continuous and intraday B0 comparison

**Neither tested stack warrants promotion.** The cash-funded overnight stack C5 improved Sharpe and Calmar vs F2 and F4 in Full and
Holdout at 2 bp, but that advantage did not survive 5 bp on the full sample or the
2022 stress window. The matched continuous F2/F4 stacks avoided collisions by skipping B0 opportunities,
not by finding a way to run both books unchanged. Keep the continuous sleeves and standalone B0 as research
controls; do not adopt either combined architecture based on this replay.

- **Overnight dominance is not universal.** Overnight provided **68.8% of SPY**, **69.3% of QQQ**, and **98.1%
  of SMH** paired gross log return. SPY and QQQ also earned positive gross daytime returns; these are
  adjusted total-return decompositions, not estimates of factor risk premia.
- **The C3 timing effect was real on this tape, but auction churn cost more.** C3 cash avoided daytime beta
  and cut the full-period drawdown from **27.81% to 22.23%** at 2 bp versus its continuous timing control.
  It nonetheless finished at **$268,258 vs $334,716**: a **+35.34** point gross log-wealth clock effect offset
  by **57.48** points of incremental cost drag. At 5 bp C3 cash finished at **$117,912**, below SHY and both
  continuous references. Actual daytime SHY generally made the auction book worse because it added trades.
  SMH-only cash was an exception to the equity-return ranking at both costs, but had a **38.50% / 44.27%**
  full-period drawdown and lost **30.39% / 35.44%** in 2022.
- **C4 did not add useful B0 to F2 or F4.** Each stack blocked **2,153 of 2,230** standalone B0 fills over
  the full period, including **all 581** in Holdout and **all 227** in 2022. The 77 accepted fills lost
  **$1,867 at 2 bp** and **$3,032 at 5 bp**, before incremental core financing costs. Both stacks finished
  below their unstacked parents at both costs, with no Holdout improvement.
- **C5's improvement was cost-dependent.** At 2 bp it reached **$441,083** (Sharpe **1.35**, Sortino **2.00**,
  Calmar **1.23**, MaxDD **11.88%**) versus F2 **$357,610**, F4 **$212,587**, and standalone B0 **$203,534**.
  At 5 bp it fell to **$198,381** (Sharpe **0.59**, MaxDD **20.20%**), below F2 and F4 and with worse Sharpe
  than standalone B0. In 2022, B0 alone gained **16.02% / 15.59%** at 2/5 bp while C5 lost **1.76% / 3.94%**.
  C5 retained a strong 5 bp Holdout return (**+76.39%**), but that one previously studied window does not
  establish production superiority. C5 traded **313× / 341×** one-way per year versus F2 **1.96×** and F4
  **0.80×** over the full sample.

## Registration and evidence

The [protocol](protocol.md) was published at
[`d8b364b97`](https://github.com/proompteng/lab/commit/d8b364b97b36e83b9d27a6cc673583043bd2fe6a).
The [Train/Validation freeze](freeze.json) was published at
[`5266509f1`](https://github.com/proompteng/lab/commit/5266509f14b4eaaf2a4384784b72530a17aa2fdb).
The scorer verified the published commit, rederived the freeze **byte for byte** before opening the Holdout
intraday object, then verified that extending the tape did not alter any development ledger. No winner
selection or parameter retuning. This is retrospective: prior waves already studied these dates.

[Results](results.json) include **570** book/window/cost cells (19 books × five windows × six tiers including
gross), **870** ETF/window/cost decomposition cells, SHA-256 ledger digests, both archived price input receipts,
calendar-year returns, paired tests vs SHY and B0, DSR, Ex-Top-10 results, daytime beta, and execution
diagnostics. The split counts are **1,511 Train / 501 Validation / 729 Holdout**, with **251** sessions in 2022.
The 2026 bucket ends November 25. All **8,641,719** development and **3,923,737** Holdout physical 5-minute
rows were authenticated; screening to regular sessions excluded **811,914 / 442,813** outside-RTH rows, not
gzip data. The development object included the authenticated 1,693-byte suffix after its one valid gzip member.

All 29 ETFs appear. Most have 2,740 pairable gaps and 2,741 daytime observations. XLC has 2,121 / 2,122
and XLRE 2,736 / 2,739; there are no synthetic prices or gap-bridging. The standalone F2/F4 terminal returns
match published Wave 5C funded-SHY evidence at 2, 5 and 10 bp for all five windows. Standalone B0 dollar P&L
and fills match Wave 6A at every common cost and window, including **$103,533.58** net at 2 bp and **$69,780.16**
at 5 bp in Full. This report's Sharpe divides dollar P&L by each actual prior NAV, not a constant $100k
denominator; the 2 bp B0 Sharpe is **1.07** rather than the original fixed-reference **1.11**. The 2 bp Full
B0 dollar drawdown is still **$8,702.36**.

To reproduce from the repo root with the published head reachable and configured read-only S3 access:

```sh
runner=services/bayn/tools/research-10yr-etf-overnight-vs-intraday.ts
evidence=docs/bayn/evidence/2026-11-27-10yr-etf-overnight-vs-intraday
scratch=$(mktemp -d)
bun "$runner" --develop --output "$scratch/freeze.json"
cmp "$scratch/freeze.json" "$evidence/freeze.json"
bun "$runner" --score --output "$scratch/results.json"
cmp "$scratch/results.json" "$evidence/results.json"
rm -- "$scratch/freeze.json" "$scratch/results.json"
rmdir "$scratch"
```

For example, `jq '.metrics.holdout[] | select(.bp == 5) | .books["C5-C3-B0"]' results.json` selects one
complete metrics cell. Both paired p-values are one-sided and use 10,000 stationary draws; the DSR is against
the Train-only SHY-excess hurdle. C5's unadjusted Holdout p vs standalone B0 is **0.0022 / 0.0160** at 2/5 bp
and DSR is **0.932 / 0.127**. In 2022 neither p-value against B0 supports improvement (both **>0.99**).
The frozen books, prior use of these dates and cost sensitivity matter more than an isolated p-value.

## Execution limits

The two stacks run in one modeled $100,000 account. C4 skips any held QQQ or SMH and covers any remaining
intraday debit with a closing core sale plus fees. C5 realized **2,230** 2 bp B0 fills, no concurrent cross-sleeve
symbol overlap, no modeled cash stress shortfall, and a maximum reserved opening gross under **1× opening NAV**
across all tiers. B0's first observed fill was no earlier than **10:00 ET** and its latest exit was at least
**15 minutes before the scheduled close**. One held B0 bar was missing; no executed exits were missing.
At 2/5 bp the conservative mark check flagged **64/270** C5 sessions: it adds core gross reserved at the
earlier marks to a bound on B0 peaks, even though C5 is flat in the core during the day. This warning is not a
simultaneous gross measurement or evidence of a loan; neither the bounds nor cash ledger prove broker
maintenance, liquidity, or margin availability. The B0 short leg still requires borrowable shares.

The daily adjusted OHLC values are **auction proxies**, not exchange auction fills. A fully funded MOO→B0→MOC
simulation does not prove that Alpaca will accept, fund or fill the orders. Under [Alpaca's documented order
cutoffs](https://docs.alpaca.markets/us/docs/orders-at-alpaca), submitting a normal-session MOC at **15:58 ET**
is too late (CLS cutoff **15:50 ET**; OPG cutoff **09:28 ET**), and realized B0 P&L may not be known by the
order entry deadline. C4's pro-rata close funding is likewise a modeled close-price execution, not an order
acceptance result. The one-times overnight and two-times intraday ceilings are imposed for this study,
not read from an account. No production strategy, deployment, migration, or capital authority changed.

## Results tables

<!-- tables derived from results.json -->

### Full-period decomposition

Close-to-open and open-to-close columns compound their usable observations independently. Log share uses only
paired observations. A share outside 0–100% means the legs offset or the total log return is negative, not that
the calculation attributes more dollars than the fund earned. See the JSON for usable counts and all windows.

| ETF  | Paired | Overnight gross | Daytime gross | Overnight log share | Overnight / daytime net, 2 bp | Overnight / daytime net, 5 bp |
| ---- | -----: | --------------: | ------------: | ------------------: | ----------------------------: | ----------------------------: |
| SPY  |   2740 |         168.25% |        56.95% |              68.77% |              46.40% / -14.36% |             -35.65% / -62.37% |
| QQQ  |   2740 |         256.41% |        75.91% |              69.25% |               94.52% / -4.01% |             -14.50% / -57.82% |
| IWM  |   2740 |         364.16% |       -39.98% |             149.04% |             153.33% / -67.25% |              11.35% / -85.61% |
| SMH  |   2740 |        1564.36% |         6.47% |              98.06% |             808.37% / -41.90% |             299.27% / -74.47% |
| XLK  |   2740 |         247.07% |       138.51% |              59.01% |               89.42% / 30.14% |             -16.74% / -42.81% |
| XLF  |   2740 |          97.49% |        53.76% |              61.36% |               7.78% / -16.10% |             -52.62% / -63.13% |
| XLV  |   2740 |          49.70% |       106.63% |              35.72% |              -18.30% / 12.75% |             -64.09% / -50.46% |
| XLY  |   2740 |         177.81% |        22.94% |              83.22% |              51.62% / -32.92% |             -33.36% / -70.52% |
| XLC  |   2121 |          97.04% |        16.75% |              81.93% |              23.30% / -26.96% |             -34.74% / -61.35% |
| XLI  |   2740 |         192.24% |        28.12% |              81.46% |              59.50% / -30.09% |             -29.89% / -69.28% |
| XLP  |   2740 |          33.83% |        83.33% |              32.49% |               -26.96% / 0.03% |             -67.89% / -56.04% |
| XLE  |   2740 |         348.11% |       -31.33% |             133.73% |             144.57% / -62.53% |               7.50% / -83.53% |
| XLU  |   2740 |          96.97% |        43.40% |              65.53% |               7.50% / -21.75% |             -52.75% / -65.62% |
| XLRE |   2736 |         212.72% |       -37.52% |             166.85% |              70.83% / -65.89% |             -24.82% / -85.00% |
| XLB  |   2740 |         103.61% |        45.13% |              65.62% |              11.13% / -20.81% |             -51.15% / -65.20% |
| TLT  |   2740 |         -26.13% |        24.09% |             364.32% |             -59.69% / -32.29% |             -82.28% / -70.25% |
| IEF  |   2740 |           7.63% |         3.68% |              66.75% |             -41.26% / -43.43% |             -74.18% / -75.14% |
| SHY  |   2740 |          21.86% |        -1.50% |             108.22% |             -33.49% / -46.26% |             -70.77% / -76.38% |
| HYG  |   2740 |          26.75% |        33.86% |              44.96% |             -30.82% / -26.96% |             -69.59% / -67.91% |
| LQD  |   2740 |          58.65% |       -15.55% |             156.80% |             -13.41% / -53.92% |             -61.94% / -79.75% |
| GLD  |   2740 |         303.49% |       -21.31% |             120.50% |             120.22% / -57.06% |              -3.20% / -81.13% |
| SLV  |   2740 |         626.27% |       -62.08% |             191.73% |             296.38% / -79.31% |              74.23% / -90.91% |
| USO  |   2740 |         215.52% |       -50.78% |             246.93% |              72.21% / -73.14% |             -24.31% / -88.20% |
| DBC  |   2740 |         172.30% |        -4.03% |             102.93% |              48.62% / -47.63% |             -34.68% / -76.99% |
| EFA  |   2740 |          23.42% |        90.47% |              24.62% |               -32.64% / 3.93% |             -70.39% / -54.33% |
| EEM  |   2740 |          55.10% |        45.58% |              53.81% |             -15.35% / -20.57% |             -62.79% / -65.10% |
| VNQ  |   2740 |         122.58% |       -16.87% |             129.21% |              21.48% / -54.64% |             -46.60% / -80.07% |
| DIA  |   2740 |         158.26% |        40.06% |              73.88% |              40.95% / -23.58% |             -38.04% / -66.42% |
| UUP  |   2740 |          29.77% |         6.44% |              81.02% |             -29.18% / -41.92% |             -68.87% / -74.48% |

### Full-period book performance

Each friction cell shows **final equity / Sharpe / MaxDD**. Turnover is one-way at 2 bp and annualized.
C0 and C1 pay only for initial purchase; no book is forced to sell at the last observed close.

| Book          |                     2 bp |                     5 bp | Turnover / yr, 2 bp | Daytime beta, 2 bp |
| ------------- | -----------------------: | -----------------------: | ------------------: | -----------------: |
| C0-SHY        |  $120,012 / 1.09 / 5.70% |  $119,994 / 1.08 / 5.70% |               0.05× |             -0.004 |
| C1-SPY        | $420,977 / 0.84 / 33.79% | $420,913 / 0.84 / 33.79% |               0.05× |              1.000 |
| C2-SPY-cash   | $146,403 / 0.36 / 33.05% | $64,351 / -0.30 / 42.81% |             251.53× |              0.000 |
| C2-SPY-SHY    | $78,693 / -0.13 / 34.53% | $15,201 / -1.44 / 85.23% |             503.05× |             -0.004 |
| C2-QQQ-cash   | $194,522 / 0.51 / 31.13% | $85,502 / -0.03 / 38.64% |             251.55× |              0.000 |
| C2-QQQ-SHY    | $104,558 / 0.10 / 37.53% | $20,198 / -0.99 / 80.63% |             503.08× |             -0.004 |
| C2-SMH-cash   | $908,369 / 1.04 / 38.50% | $399,272 / 0.69 / 44.27% |             251.63× |              0.000 |
| C2-SMH-SHY    | $488,259 / 0.78 / 44.10% |  $94,319 / 0.08 / 58.91% |             503.24× |             -0.004 |
| C2-60-40-cash | $91,025 / -0.08 / 32.84% | $40,010 / -1.14 / 61.39% |             251.51× |              0.000 |
| C2-60-40-SHY  | $48,927 / -0.86 / 52.88% |  $9,451 / -2.93 / 90.71% |             503.01× |             -0.004 |
| C3-cash       | $268,258 / 1.02 / 22.23% | $117,912 / 0.21 / 31.56% |             251.56× |              0.000 |
| C3-SHY        | $180,597 / 0.62 / 28.19% | $47,356 / -0.68 / 56.97% |             409.63× |             -0.004 |
| C3-continuous | $334,716 / 0.83 / 27.81% | $321,009 / 0.80 / 28.38% |              12.79× |              0.406 |
| F2            | $357,610 / 0.98 / 19.21% | $355,332 / 0.98 / 19.21% |               1.96× |              0.454 |
| F4            | $212,587 / 1.25 / 10.04% | $212,032 / 1.25 / 10.04% |               0.80× |              0.189 |
| C4-F2-B0      | $350,974 / 0.96 / 19.21% | $344,620 / 0.95 / 19.21% |               5.55× |              0.455 |
| C4-F4-B0      | $208,643 / 1.19 / 10.04% | $205,640 / 1.17 / 10.04% |               4.39× |              0.191 |
| C5-C3-B0      | $441,083 / 1.35 / 11.88% | $198,381 / 0.59 / 20.20% |             313.32× |             -0.016 |
| B0            |  $203,534 / 1.07 / 7.73% |  $169,780 / 0.73 / 9.66% |              78.61× |             -0.020 |

### Holdout and 2022 stress

Each window is rebased to $100,000 with no change to its inherited holdings or sizing state.
Cells show **terminal return / MaxDD**; returns below are not annualized.

| Book          |    Holdout 2 bp |    Holdout 5 bp |        2022 2 bp |        2022 5 bp |
| ------------- | --------------: | --------------: | ---------------: | ---------------: |
| C0-SHY        |  10.74% / 0.98% |  10.74% / 0.98% |   -3.88% / 4.97% |   -3.88% / 4.97% |
| C1-SPY        | 55.73% / 18.75% | 55.73% / 18.75% | -18.18% / 24.50% | -18.18% / 24.50% |
| C3-cash       |  81.02% / 9.12% |  45.46% / 9.90% | -11.34% / 13.69% | -17.77% / 18.88% |
| C3-SHY        |  54.76% / 8.96% |  4.43% / 12.73% | -15.79% / 18.07% | -24.26% / 25.06% |
| C3-continuous | 61.36% / 16.51% | 59.40% / 16.73% | -21.56% / 26.62% | -21.73% / 26.78% |
| F2            | 72.66% / 10.19% | 72.44% / 10.19% |   1.31% / 16.30% |   1.25% / 16.31% |
| F4            |  37.44% / 6.14% |  37.35% / 6.14% |   -1.52% / 5.61% |   -1.53% / 5.61% |
| C4-F2-B0      | 72.66% / 10.19% | 72.44% / 10.19% |   1.31% / 16.30% |   1.25% / 16.31% |
| C4-F4-B0      |  37.44% / 6.14% |  37.35% / 6.14% |   -1.52% / 5.61% |   -1.53% / 5.61% |
| C5-C3-B0      | 104.10% / 8.08% |  76.39% / 8.92% |   -1.76% / 8.09% |  -3.94% / 11.71% |
| B0            |  24.80% / 2.90% |  22.89% / 4.12% |   16.02% / 4.92% |   15.59% / 5.98% |

### C3 matched clock attribution

Differences are in log-wealth percentage points (100 × log ratio), not simple-return percentage points.
Gross clock effect minus incremental execution drag equals the net overnight-only minus continuous result.

| Window / overnight variant | Gross clock effect | 2 bp drag | 2 bp net | 5 bp drag | 5 bp net |
| -------------------------- | -----------------: | --------: | -------: | --------: | -------: |
| Full / cash                |             35.34% |    57.48% |  -22.13% |   135.50% | -100.15% |
| Full / shy                 |             33.83% |    95.53% |  -61.70% |   225.20% | -191.38% |
| Holdout / cash             |             26.70% |    15.21% |   11.49% |    35.85% |   -9.15% |
| Holdout / shy              |             23.90% |    28.08% |   -4.18% |    66.19% |  -42.29% |
| 2022 / cash                |             17.63% |     5.38% |   12.25% |    12.69% |    4.94% |
| 2022 / shy                 |             14.74% |     7.64% |    7.10% |    18.02% |   -3.27% |
