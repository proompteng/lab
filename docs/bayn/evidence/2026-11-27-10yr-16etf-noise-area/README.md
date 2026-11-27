# Wave 6A — 10.9-year cross-asset Noise Area Momentum

**Verdict: do not expand to the full 16-ETF inverse-volatility book on this evidence.** In the 729-session
frozen Holdout, the primary book earned **+$1,313 at 2 bp** but lost **$8,092 at 5 bp** and **$23,768 at 10 bp**.
At the registered 5 bp cost it trailed the same-rule QQQ+SMH book by **$39,720** and exact Wave 5A C5 by
**$25,435**. After removing the ten best days it lost **$17,747**. The positive **$3,553** result at 5 bp with SHY
is a carry-overlay result: SHY alone added **$11,645** over the same window. The cross-asset intraday sleeve
reduced rather than increased that return.

The frozen primary is **B4 / 30 minutes / 1.4× / opposite band / inverse vol**. This retrospective test scored
all 2,741 regular sessions, including 21 early closes, with causal five-minute-open fills and no permitted
overnight carry of intraday positions. It is not a capital grant or a forward deployment recommendation.

## Evidence and audit trail

- [Protocol](protocol.md) and [development freeze](freeze.json) were published in
  [`2ce5e98077`](https://github.com/proompteng/lab/commit/2ce5e980776bc2fd00d24cc9d1f4188050c08b3b)
  before the first Holdout price read. The first score attempt rejected the headerless Holdout TSV at its first row,
  before strategy scoring. The [transport-only erratum](transport-erratum.json) was separately published in
  [`2781b0544f`](https://github.com/proompteng/lab/commit/2781b0544fc4b5b246757ec622c2e28ed9232bd3);
  the program authenticated the original freeze and regenerated every development ledger and ranking before replay.
  Neither archive, the model, the statistical gate nor the protocol changed.
- [Results](results.json) contains the full 1/2/3/5/10 bp × zero cash/SHY metrics by split and year, 16 singletons,
  16 reweighted leave-one-ETF-out runs, conditional 14-name replay, 16×16 daily correlation matrices, all
  descriptive Holdout grid scores, plateau, paired bootstrap tests and cumulative DSR.
- The exact C5 replay reproduces [Wave 5A](https://github.com/proompteng/lab/pull/16377) to the cent: 2016–2023
  **$41,848.66 at 2 bp / $17,311.01 at 5 bp**, and stitched **$67,164.47 / $34,653.76**, respectively.
  Its reference history was already observed on both sides of the split. The other 14 names are newly scored
  in this experiment, not necessarily historically unstudied. Matching parameters between B4 and B0 keeps the
  effect of changing strategy rules separate from the effect of broadening the basket.

## Annual verdict

Amounts are USD at the fixed $100,000 sizing reference after scenario friction and the sell fee. B4 is the
frozen primary and the five numbered B4 columns are pure intraday P&L.

| Year  | Sessions | B4 1 bp    | B4 2 bp    | B4 3 bp    | B4 5 bp    | B4 10 bp   | B4 5 bp + SHY | C5 5 bp |
| ----- | -------- | ---------- | ---------- | ---------- | ---------- | ---------- | ------------- | ------- |
| 2016  | 252      | −$1,229    | −$2,271    | −$3,314    | −$5,399    | −$10,611   | −$4,766       | −$2,085 |
| 2017  | 251      | −$755      | −$1,809    | −$2,863    | −$4,970    | −$10,239   | −$4,706       | −$503   |
| 2018  | 251      | $4,197     | $3,057     | $1,917     | −$363      | −$6,064    | $1,107        | $2,943  |
| 2019  | 252      | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved    | −$6,034 |
| 2020  | 253      | $421       | −$639      | −$1,700    | −$3,821    | −$9,124    | −$616         | $1,835  |
| 2021  | 252      | $682       | −$424      | −$1,529    | −$3,740    | −$9,267    | −$4,519       | $8,640  |
| 2022  | 251      | −$105      | −$1,242    | −$2,380    | −$4,654    | −$10,342   | −$8,860       | $9,538  |
| 2023  | 250      | $2,471     | $1,390     | $310       | −$1,851    | −$7,253    | $2,487        | $2,976  |
| 2024  | 252      | $667       | −$422      | −$1,511    | −$3,688    | −$9,131    | $561          | $3,578  |
| 2025  | 250      | $1,383     | $330       | −$723      | −$2,829    | −$8,094    | $2,744        | $7,117  |
| 2026¹ | 227      | $2,399     | $1,406     | $412       | −$1,575    | −$6,542    | $249          | $6,647  |

¹ Through November 25. On August 12, 2019 the tape lacks open prices needed to prove three primary exits at
or before the deadline. 2019, Train and Full net are therefore unresolved, **not zero**. At 5 bp, known closed-leg
P&L was **−$5,703 in 2019** and **−$38,594 in Full**; these values are not net or bounds. As a separate sensitivity,
dropping that one entire session from _all_ core books leaves B4 at **−$5,705** in 2019 and **−$38,596** over
2,740 matched sessions. At 5 bp all ten fully measured years were negative for B4; C5 was positive in eight
of eleven. The data do not prove 100% flattening or a complete cumulative DSR for B4: the report withholds
full-calendar statistics from the first unresolved exit onward for the cumulative calculation.

## Friction and SHY

| Window/book        | 1 bp       | 2 bp       | 3 bp       | 5 bp       | 10 bp      | 5 bp + SHY |
| ------------------ | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| B4 train           | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved |
| B4 validation      | $2,366     | $148       | −$2,070    | −$6,505    | −$17,595   | −$6,373    |
| B4 holdout         | $4,449     | $1,313     | −$1,822    | −$8,092    | −$23,768   | $3,553     |
| B4 full            | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved | Unresolved |
| C5 Holdout         | $27,974    | $25,316    | $22,658    | $17,343    | $4,054     | $28,988    |
| C5 Full            | $78,001    | $67,164    | $56,328    | $34,654    | −$19,531   | $54,695    |
| Matched B0 Holdout | $43,382    | $40,443    | $37,505    | $31,628    | $16,936    | $43,274    |
| Matched B0 Full    | $114,785   | $103,534   | $92,282    | $69,780    | $13,524    | $89,821    |

SHY's separately pinned split- and dividend-adjusted daily series gained **20.04% ($20,041)** over the
stitched period, on a continuously held $100,000 benchmark funded at the first study close. The overlay
adds those same dollar changes to each book, with no compounding of intraday P&L. The result is not
frictionless collateral or a guarantee of overnight yield.

[Consolidated SIP quote spot check](nbbo-spot-check.json): all 48 registered symbol/date requests returned
data, with 432 positive, nonlocked/noncrossed, displayed two-sided updates. The pooled spread was
**1.29 bp median**, **2.60 bp p75**, and **0.15–25.11 bp** from minimum to maximum. ETF-level medians ranged
from **0.32 bp (QQQ)** to **8.50 bp (XBI)**. This is a small snapshot of quote _updates_, not a time-weighted
or fill-aligned cost estimate. The 1–10 bp assumptions are scenarios calibrated for scale; the bar archives
contain no historical fills or NBBO matching and cannot establish impact, locates or financing costs.

## Holdout breadth and robustness

| Holdout book            | 1 bp    | 2 bp    | 3 bp    | 5 bp     | 10 bp    | 5 bp + SHY |
| ----------------------- | ------- | ------- | ------- | -------- | -------- | ---------- |
| B0                      | $43,382 | $40,443 | $37,505 | $31,628  | $16,936  | $43,274    |
| B1                      | $21,007 | $17,939 | $14,871 | $8,734   | −$6,608  | $20,379    |
| B2                      | $17,114 | $13,334 | $9,554  | $1,994   | −$16,905 | $13,640    |
| B3                      | $6,525  | $2,923  | −$678   | −$7,882  | −$25,891 | $3,764     |
| B4                      | $5,901  | $2,054  | −$1,792 | −$9,486  | −$28,720 | $2,159     |
| B4 primary              | $4,449  | $1,313  | −$1,822 | −$8,092  | −$23,768 | $3,553     |
| B4 matched equal weight | $10,541 | $7,489  | $4,436  | −$1,668  | −$16,928 | $9,978     |
| Exact C5                | $27,974 | $25,316 | $22,658 | $17,343  | $4,054   | $28,988    |
| B4 without QQQ/SMH      | $1,463  | −$1,696 | −$4,856 | −$11,175 | −$26,972 | $471       |

At the primary 5 bp, Holdout annualized Sharpe was **−0.914**, maximum drawdown **$11,181**, Calmar **−0.250**,
break-even **2.42 bp**, active days **721/729**, win rate **42.30%**, and profit factor **0.821**. The one-sided
10,000-draw stationary-bootstrap p-value for positive alpha was **0.94421**; DSR was **0.000071**. Paired
one-sided p-values for improvement over C5 and matched B0 were **0.99810** and **0.99860**. None establishes
improvement. B4's local plateau was **0/3 (0%)** at 5 bp in all three splits. The same B4 rules with equal
weights did better than inverse-volatility parity in Holdout at 5 bp, but both lost money. The 14 new names
without QQQ/SMH lost **$11,175** at 5 bp.

The table below shows **Holdout intraday alpha at 5 bp**, not in-book contributions. Standalones use their own
$100,000 sizing reference. Each omission reruns portfolio weights and keeps the B4 signal/clock/exit unchanged.

| ETF  | Standalone | Book without ETF | LOEO minus B4 |
| ---- | ---------- | ---------------- | ------------- |
| SPY  | $5,106     | −$8,851          | −$759         |
| QQQ  | $20,852    | −$9,580          | −$1,488       |
| IWM  | −$19,499   | −$7,923          | $169          |
| SMH  | $51,429    | −$9,676          | −$1,584       |
| XLK  | $37,712    | −$10,133         | −$2,041       |
| XLF  | −$32,873   | −$6,553          | $1,539        |
| XLE  | −$8,822    | −$8,075          | $17           |
| XLV  | −$19,497   | −$7,126          | $966          |
| XLI  | −$13,069   | −$7,696          | $396          |
| XLY  | −$1,190    | −$8,602          | −$510         |
| XBI  | −$10,614   | −$8,144          | −$52          |
| ARKK | $60,705    | −$9,796          | −$1,704       |
| TLT  | −$16,725   | −$7,260          | $832          |
| IEF  | −$17,795   | −$6,066          | $2,026        |
| GLD  | −$13,890   | −$7,760          | $332          |
| USO  | −$47,818   | −$6,864          | $1,228        |

No single omission made the 5 bp Holdout profitable. The results contain full-period and annual diagnostics
and both cash branches for every ETF and omission, and separate pairwise-complete correlation sample counts.

## Tape coverage and limits

The two physical bar objects reconciled to **8,641,719** and **3,923,737** rows; the exchange calendars excluded
**811,914** and **442,813** outside regular hours. All 16 funds have observed bars on the first and last session
of both pinned segments. ARKK nevertheless has eight isolated missing development sessions and 299 dates with
no last-five-minute opening bar. The primary Holdout has **zero unresolved exits or observed held-bar gaps**;
its conservative peak absolute-gross bound was **$102,966**, below $180,000. Over the full archive, three
unresolved exits and 200 held-slot gaps prevent proving complete flatness and continuous marked gross. All 16
funds were available pre-2016, with no late IPO admission, replacement or retrospective membership changes;
the supplied cohort does not prove absence of survivorship bias relative to all eligible ETFs in 2016.

### Reproduce on the published study branch

```sh
study=services/bayn/tools/research-10yr-16etf-noise-area.ts
bun "$study" --score --output /tmp/noise-area-wave6a-replay.json
```

Use the existing read-only S3 credentials and endpoint for the pinned artifacts. Score requires a clean,
published HEAD on the assigned branch, the original freeze and its transport erratum. The official receipt
records the exact scoring commit. Development-only reproduction at the original freeze commit uses
`bun "$study" --develop --output /tmp/noise-area-wave6a-development.json`; it never requests Holdout bars.
