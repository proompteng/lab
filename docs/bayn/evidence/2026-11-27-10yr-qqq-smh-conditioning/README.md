# Wave 9B — 10.9-year QQQ + SMH Noise Area conditioning

**Keep pure, unconditioned `B0/30/1.4/opposite_band/inverse_vol_parity`.** All 26 conditioning variants
earned less than B0 in the 729-session Holdout at **both** 2 and 5 bp. The development-selected contender
(RVOL confirmation plus the 1.5× ATR stop) lost **$8,239 at 2 bp** and **$6,520 at 5 bp** relative to B0.
Its 5 bp DSR was **0.9295**, below 0.95. The standalone catastrophic stop also degraded net and Sharpe in
Train and Holdout, so it did not earn the protocol's safety-only exception. This research verdict does not
change or waive any live protection, execution, or capital requirement.

## Control and freeze

The [protocol](protocol.md) preceded the development run. The [development receipt](freeze.json) was committed
and pushed in [`405c783b49`](https://github.com/proompteng/lab/commit/405c783b49b53cdec68338f682e73e73814326ce)
before Holdout or SHY price access. The score command verified the published revision and regenerated the
receipt on all 2,012 Train and Validation sessions before requesting either tape. Train's finalists were
`V0/R1/X2`, `V1/R1/X2`, and `V0/R1/X1`; Validation chose `V0/R1/X1`. No Holdout selection followed.
[Results](results.json) records the freeze hash, source identities, complete Holdout ablations, and split and
annual metrics for the baseline, contender, standalone safety stop and separate XLK diagnostic.

**B0 reproduced [Wave 6A](https://github.com/proompteng/lab/pull/16387) to the cent** on every split and on the
stitched 2,741 sessions, after the specified friction and 0.21 bp sell fee. All dollar figures use the fixed
$100,000 sizing reference.

| Window     | Sessions | B0 net, 2 bp | B0 net, 5 bp | B0 Sharpe, 2 / 5 bp |
| ---------- | -------: | -----------: | -----------: | ------------------: |
| Train      |    1,511 |   $33,107.45 |   $14,806.00 |         0.76 / 0.34 |
| Validation |      501 |   $29,982.77 |   $23,345.90 |         1.44 / 1.12 |
| Holdout    |      729 |   $40,443.36 |   $31,628.26 |         1.49 / 1.17 |
| Full       |    2,741 |  $103,533.58 |   $69,780.16 |         1.11 / 0.75 |

B0's full 2 bp maximum drawdown was **$8,702**, ex-top-ten net **$69,434**, and one-sided alpha bootstrap
`p = 0.00010`. At 5 bp maximum drawdown was **$10,905**, break-even cost **11.20 bp RT**, and alpha
`p = 0.00470`. The year-level data support the original friction concern: 2016 and 2017 were modestly
positive at 2 bp but negative at 5 bp, while 2019 was negative at both. No year was excluded or retuned.

## Holdout conditioning effects

Paired deltas are daily candidate net minus the exact baseline, on the same sessions. The single-axis rows
are descriptive; only the frozen contender is eligible for the formal decision. DSR measures standalone
performance against the frozen Train benchmark, not improvement over B0.

| Candidate                     | Δ at 2 bp | Paired p, 2 bp | DSR, 2 bp | Δ at 5 bp | Paired p, 5 bp | DSR, 5 bp |
| ----------------------------- | --------: | -------------: | --------: | --------: | -------------: | --------: |
| **Frozen: RVOL + ATR**        |   −$8,239 |         0.9817 |    0.9859 |   −$6,520 |         0.9495 |    0.9295 |
| V1 minimum volatility         |   −$1,947 |         0.7554 |    0.9974 |     −$560 |         0.5771 |    0.9779 |
| V2 volatility targeting       |  −$21,054 |         0.9771 |    0.9868 |  −$18,142 |         0.9615 |    0.9097 |
| R1 RVOL                       |   −$7,597 |         0.9735 |    0.9885 |   −$5,878 |         0.9315 |    0.9383 |
| R2 VWAP                       |     −$973 |         0.9196 |    0.9967 |     −$974 |         0.9196 |    0.9685 |
| X1 catastrophic ATR stop      |     −$642 |         0.9191 |    0.9966 |     −$642 |         0.9191 |    0.9687 |
| X2 ATR + trailing profit lock |     −$265 |         0.6650 |    0.9970 |     −$265 |         0.6650 |    0.9710 |

The frozen contender reduced Holdout maximum drawdown from $5,484 to $4,269 at 2 bp and $6,592 to $5,592 at
5 bp, but lowered Sharpe from 1.49 to 1.21 and 1.17 to 0.95, respectively. Its 5 bp ex-top-ten net was
**−$4,782**. X1 alone mildly reduced full-period drawdown, but lost $2,420 vs B0 in Train at 5 bp and $642
in Holdout, with unchanged Holdout MaxDD. It was not non-degrading.

The primary and baseline had no unresolved exits or held-bar gaps in Holdout. The previously reported
B0 held-bar gap on **2016-02-02** remained in the full replay; its leg resolved at an observed open. It
independently vetoed the protocol's full-path qualification, not Holdout paired inference. No variant
had a positive Holdout delta, so the retention verdict holds independently of that veto. The digests and
calendars reconciled **8,641,719 development** and **3,923,737 Holdout** physical rows, excluding 811,914 and
442,813 outside RTH and retaining all 21 early closes.

## Separate diagnostic: add XLK, with no retuning

The following compares the same Wave 6A rule and common cost per fill with and without XLK. Each cell is
**net / annualized Sharpe / maximum drawdown**. Lower drawdown is better.

| Window     | RT cost | QQQ + SMH                 | QQQ + SMH + XLK           |
| ---------- | ------: | ------------------------- | ------------------------- |
| Train      |    2 bp | $33,107 / 0.756 / $8,702  | $32,164 / 0.757 / $8,111  |
| Train      |    5 bp | $14,806 / 0.339 / $10,905 | $13,936 / 0.329 / $10,778 |
| Validation |    2 bp | $29,983 / 1.440 / $6,557  | $32,163 / 1.634 / $7,152  |
| Validation |    5 bp | $23,346 / 1.124 / $6,875  | $25,569 / 1.303 / $7,463  |
| 2016–2023  |    2 bp | $63,090 / 0.963 / $8,702  | $64,327 / 1.021 / $8,111  |
| 2016–2023  |    5 bp | $38,152 / 0.584 / $10,905 | $39,505 / 0.629 / $10,778 |
| 2024–2026  |    2 bp | $40,443 / 1.487 / $5,484  | $42,467 / 1.541 / $5,289  |
| 2024–2026  |    5 bp | $31,628 / 1.167 / $6,592  | $33,599 / 1.224 / $6,972  |
| Full       |    2 bp | $103,534 / 1.115 / $8,702 | $106,795 / 1.175 / $8,111 |
| Full       |    5 bp | $69,780 / 0.753 / $10,905 | $73,104 / 0.807 / $10,778 |

The three-name book had higher Sharpe in pooled development and Holdout at both costs, and lower
drawdown in pooled development. In Holdout its 5 bp drawdown was **$381 worse**, and in Train it earned less
at both costs. At 5 bp it lost in four development years (2016, 2017, 2019, 2020) vs three for B0 (2016,
2017, 2019); both were positive in each of the three Holdout years. XLK lifted 2024 and 2025 5 bp net but
reduced it in partial 2026 ($14,079 vs $14,449). The breadth diagnostic improved aggregate returns and Sharpe,
not all measures of stability. It had no confirmatory gate and did not compete with the 27 registered cells.

## Carry and reproduction

The separately authenticated SHY overlay adds **$20,041** over the stitched window and **$11,645** in
Holdout to every book. B0's stitched 5 bp net rises from $69,780 to $89,821 with that overlay. This is a
buy-and-hold benchmark scenario, not additional intraday alpha or guaranteed collateral economics. Carry
does not participate in the conditioning verdict.

Use the existing read-only artifact credentials at the pinned endpoint. Run from the repository root on
the published study branch. The command refuses to overwrite evidence and requires the original tracked freeze
and locked code.

```sh
study=services/bayn/tools/research-10yr-qqq-smh-conditioning.ts
bun "$study" --develop --output /tmp/w9b-development.json
bun "$study" --score --output /tmp/w9b-results.json
```

These are historical bar simulations. The pair and market periods were researched before Wave 9B;
the development-only freeze protects this selection, not independence from earlier experiments.
The replay does not model actual bid/ask fills, market impact, borrowing/financing, or prospective performance.
