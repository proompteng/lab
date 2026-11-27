# Wave 5A — frozen intraday strategies on unseen 2016–2023 SIP tape

**Blind verdict:** C5 (QQQ+SMH Noise) was the only fully resolved variant with positive net at any tested cost.
It earned **$41,848.66 at 2 bp** (one-sided bootstrap `p = 0.00850`; **$19,873.14** after removing its best ten
days), **$17,311.01 at 5 bp** (`p = 0.15998`; **−$4,371.21** ex-top-ten), and **lost $23,585.08 at 10 bp**.
C1 and every OR5 variant lost money at all three costs. Reversion and the combined books had negative known
closed-leg P&L at 5 and 10 bp, and missing exit prices prevent a complete net verdict at any cost. No variant
demonstrated a positive blind net across all three costs.

The [Wave 4E protocol](protocol.md), [freeze](freeze.json), strategy parameters, selection, and fills were not changed.
C1 is the registered approximation of the Live v2 21-name baseline, not a replay of the live trading path.
The stitched history includes the already-inspected 2024–2026 segment and is **not** a second independent test.
This is retrospective research, not deployment or capital authority.

## Eight-year blind aggregate

All dollar figures are USD at fixed $100,000 starting equity. Costs are round-trip basis points, plus the registered
sell-side fee. **†** shows known closed-leg P&L when at least one trade is unresolved; it is neither full net nor a
bound on it. Sharpe, bootstrap p-values and other full-net statistics are not computed for such windows.

| Frozen candidate           | Net · 2 bp    | Net · 5 bp    | Net · 10 bp   | Active days | Unresolved days |
| -------------------------- | ------------- | ------------- | ------------- | ----------- | --------------- |
| C1 · Live v2 approximation | -$36,573.63   | -$113,973.76  | -$242,973.97  | 1959        | 0               |
| C2 · OR5, 2R               | -$28,965.35   | -$37,935.75   | -$52,886.42   | 694         | 0               |
| C3 · OR5, 3R               | -$39,822.34   | -$48,792.77   | -$63,743.49   | 694         | 0               |
| C3 · OR5, K=2              | -$26,212.62   | -$34,232.31   | -$47,598.47   | 760         | 0               |
| C4 · Noon timed            | -$12,681.04†  | -$21,466.94†  | -$36,110.10†  | 163         | 1               |
| C4 · Noon brackets         | -$16,738.03†  | -$25,523.39†  | -$40,165.66†  | 163         | 1               |
| C4 · Noon ungated ablation | -$115,330.58† | -$219,838.05† | -$394,017.17† | 1937        | 3               |
| C5 · QQQ+SMH 30m Noise     | $41,848.66    | $17,311.01    | -$23,585.08   | 1251        | 0               |
| C6 · Two-engine 75/25      | -$24,891.59†  | -$33,814.32†  | -$48,685.54†  | 784         | 1               |
| C7 · Three-engine equal    | $40.63†       | -$14,022.33†  | -$37,460.59†  | 1495        | 1               |
| C7 · Three-engine OR5 tilt | -$7,296.09†   | -$20,075.16†  | -$41,373.60†  | 1495        | 1               |

## Calendar-year and stitched net

Each cell is **2 / 5 / 10 bp RT**. A **†** has the same meaning as above. The exact, unrounded metrics for every
cell are in [results.json](results.json), along with the separate inspected continuity window.

| Candidate   | 2016 (252 sessions)                    | 2017 (251 sessions)                     | 2018 (251 sessions)                     | 2019 (252 sessions)                        |
| ----------- | -------------------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------ |
| C1          | -$7,471.82 / -$16,019.07 / -$30,264.49 | -$18,679.12 / -$28,651.69 / -$45,272.63 | -$15,697.74 / -$25,671.28 / -$42,293.86 | -$20,939.29 / -$30,810.16 / -$47,261.61    |
| C2          | -$7,543.61 / -$8,489.33 / -$10,065.53  | -$1,644.92 / -$2,792.16 / -$4,704.22    | $5,315.11 / $4,320.82 / $2,663.67       | $6,169.52 / $5,137.65 / $3,417.88          |
| C3_3R       | -$9,548.62 / -$10,494.07 / -$12,069.81 | -$422.71 / -$1,569.66 / -$3,481.24      | $2,411.89 / $1,417.17 / -$240.71        | $6,043.90 / $5,012.20 / $3,292.70          |
| C3_top2     | -$5,995.79 / -$6,842.88 / -$8,254.71   | -$2,420.82 / -$3,527.17 / -$5,371.08    | -$187.22 / -$1,138.50 / -$2,723.96      | $2,801.68 / $1,825.65 / $198.95            |
| C4_timed    | -$3,585.20 / -$3,639.29 / -$3,729.45   | -$24.00 / -$78.14 / -$168.36            | $4,888.42 / $4,188.93 / $3,023.12       | -$3,126.91 / -$3,396.27 / -$3,845.19       |
| C4_brackets | -$3,585.20 / -$3,639.29 / -$3,729.45   | -$24.00 / -$78.14 / -$168.36            | $5,860.10 / $5,160.47 / $3,994.41       | -$3,126.91 / -$3,396.27 / -$3,845.19       |
| C4_ungated  | -$4,519.58 / -$15,856.01 / -$34,750.06 | -$30,524.09 / -$43,752.71 / -$65,800.41 | $3,571.27 / -$9,921.57 / -$32,409.63    | -$16,177.09† / -$29,711.82† / -$52,269.69† |
| C5          | $1,517.49 / -$2,084.62 / -$8,088.13    | $3,579.04 / -$502.55 / -$7,305.21       | $6,155.80 / $2,942.94 / -$2,411.82      | -$3,023.61 / -$6,034.26 / -$11,052.03      |
| C6          | -$6,555.62 / -$7,278.38 / -$8,482.99   | -$1,240.95 / -$2,114.81 / -$3,571.25    | $5,208.11 / $4,287.71 / $2,753.71       | $3,836.32 / $2,995.32 / $1,593.66          |
| C7_equal    | -$3,200.39 / -$4,732.49 / -$7,285.97   | $628.19 / -$1,130.42 / -$4,061.44       | $5,430.44 / $3,797.88 / $1,076.94       | $9.24 / -$1,424.98 / -$3,815.35            |
| C7_tilt     | -$4,289.47 / -$5,674.49 / -$7,982.86   | $66.19 / -$1,538.71 / -$4,213.55        | $5,399.02 / $3,927.07 / $1,473.82       | $1,549.03 / $216.21 / -$2,005.16           |

| Candidate   | 2020 (253 sessions)                     | 2021 (252 sessions)                     | 2022 (251 sessions)                      | 2023 (250 sessions)                     |
| ----------- | --------------------------------------- | --------------------------------------- | ---------------------------------------- | --------------------------------------- |
| C1          | -$15,579.81 / -$24,805.58 / -$40,181.87 | $9,184.19 / -$858.51 / -$17,596.36      | $21,282.16 / $11,467.77 / -$4,889.57     | $11,327.79 / $1,374.77 / -$15,213.59    |
| C2          | -$4,571.57 / -$5,699.16 / -$7,578.46    | -$11,209.81 / -$12,542.91 / -$14,764.73 | -$2,649.58 / -$3,676.45 / -$5,387.90     | -$12,830.49 / -$14,194.23 / -$16,467.13 |
| C3_3R       | -$3,450.64 / -$4,577.87 / -$6,456.60    | -$12,162.67 / -$13,495.68 / -$15,717.36 | -$7,931.29 / -$8,958.77 / -$10,671.25    | -$14,762.21 / -$16,126.09 / -$18,399.22 |
| C3_top2     | -$3,356.09 / -$4,307.16 / -$5,892.28    | -$9,835.14 / -$10,881.37 / -$12,625.08  | -$1,667.83 / -$2,479.77 / -$3,832.99     | -$5,551.39 / -$6,881.11 / -$9,097.31    |
| C4_timed    | -$6,071.39 / -$6,991.76 / -$8,525.71    | -$8,585.03 / -$9,934.41 / -$12,183.37   | $6,061.11† / $1,650.41† / -$5,700.76†    | -$2,238.03 / -$3,266.42 / -$4,980.40    |
| C4_brackets | -$5,497.77 / -$6,418.05 / -$7,951.86    | -$9,159.69 / -$10,508.35 / -$12,756.11  | $128.76† / -$4,281.80† / -$11,632.73†    | -$1,333.30 / -$2,361.96 / -$4,076.38    |
| C4_ungated  | -$53,009.73 / -$65,476.33 / -$86,254.00 | -$25,309.95 / -$38,854.99 / -$61,430.06 | $1,417.98† / -$11,982.67† / -$34,317.07† | $9,220.61 / -$4,281.96 / -$26,786.25    |
| C5          | $4,400.72 / $1,835.21 / -$2,440.64      | $11,674.14 / $8,640.46 / $3,584.32      | $11,593.74 / $9,538.02 / $6,111.82       | $5,951.33 / $2,975.81 / -$1,983.39      |
| C6          | -$4,942.26 / -$6,017.94 / -$7,810.73    | -$10,552.12 / -$11,888.72 / -$14,116.37 | -$466.89† / -$2,339.62† / -$5,460.84†    | -$10,178.17 / -$11,457.88 / -$13,590.72 |
| C7_equal    | -$2,079.57 / -$3,612.68 / -$6,167.85    | -$2,705.32 / -$4,603.67 / -$7,767.59    | $4,994.89† / $2,503.42† / -$1,649.02†    | -$3,036.84 / -$4,819.39 / -$7,790.30    |
| C7_tilt     | -$2,712.87 / -$4,143.23 / -$6,527.16    | -$4,892.71 / -$6,647.56 / -$9,572.31    | $3,074.12† / $950.92† / -$2,587.76†      | -$5,489.41 / -$7,165.37 / -$9,958.62    |

| Candidate   | 2024–2026 continuity (729 sessions)  | 2016–2026 stitched (2,741 sessions)          |
| ----------- | ------------------------------------ | -------------------------------------------- |
| C1          | $27,705.48 / -$184.03 / -$46,666.56  | -$8,868.15 / -$114,157.79 / -$289,640.53     |
| C2          | $28,002.32 / $24,261.92 / $18,027.91 | -$963.03 / -$13,673.84 / -$34,858.52         |
| C3_3R       | $27,294.93 / $23,554.42 / $17,320.24 | -$12,527.41 / -$25,238.35 / -$46,423.25      |
| C3_top2     | $661.85 / -$2,797.83 / -$8,563.96    | -$25,550.77 / -$37,030.14 / -$56,162.43      |
| C4_timed    | $66,378.54 / $54,885.51 / $35,730.47 | $53,697.50† / $33,418.57† / -$379.64†        |
| C4_brackets | $60,676.85 / $49,183.83 / $30,028.80 | $43,938.82† / $23,660.44† / -$10,136.86†     |
| C4_ungated  | $95,678.93 / $56,381.79 / -$9,113.44 | -$19,651.65† / -$163,456.26† / -$403,130.62† |
| C5          | $25,315.81 / $17,342.75 / $4,054.32  | $67,164.47 / $34,653.76 / -$19,530.76        |
| C6          | $37,598.69 / $31,922.80 / $22,462.99 | $12,707.11† / -$1,891.52† / -$26,222.55†     |
| C7_equal    | $39,711.26 / $32,011.43 / $19,178.38 | $39,751.89† / $17,989.11† / -$18,282.20†     |
| C7_tilt     | $36,671.36 / $29,972.64 / $18,808.10 | $29,375.27† / $9,897.48† / -$22,565.49†      |

The 10.9-year curves share 2,741 official session dates, keep the initial cash warm-up, and carry state across the
2023/2024 seam. Five curves (C1, all three OR5 rows, and C5) are fully observed at each cost. C4 ungated first
becomes unresolved on 2019-08-12; the other C4 variants and combined books first become unresolved on 2022-01-26.
From that first missing exit onward, those curves correctly remain `null` rather than assuming a fill or a flat day.

## Robustness and survivorship

The blind 5 bp cross-check below uses **daily** win rate/profit factor and 252-session annualization.
Worst LOSO is the lowest net from fully resolved single-symbol omissions; **complete / tested** shows how much
of the registered omission set could be ranked. SPY remains the benchmark.

| Candidate   | Ex-top-5     | Ex-top-10    | Sharpe | MaxDD       | Calmar | Breakeven RT bp | Win rate | PF    | Bootstrap p | Worst LOSO       | Complete / tested |
| ----------- | ------------ | ------------ | ------ | ----------- | ------ | --------------- | -------- | ----- | ----------- | ---------------- | ----------------- |
| C1          | -$125,786.95 | -$135,212.74 | -1.493 | $135,540.20 | -0.105 | 0.582           | 44.46%   | 0.778 | 1.00000     | QQQ -$125,355.18 | 20 / 20           |
| C2          | -$49,439.10  | -$59,428.33  | -0.689 | $38,825.84  | -0.122 | -7.687          | 44.24%   | 0.829 | 0.97110     | ORCL -$45,252.88 | 46 / 46           |
| C3_3R       | -$62,565.90  | -$71,062.84  | -0.892 | $49,209.23  | -0.124 | -11.318         | 43.52%   | 0.783 | 0.99440     | ORCL -$56,344.14 | 46 / 46           |
| C3_top2     | -$41,785.23  | -$47,562.89  | -0.932 | $34,467.19  | -0.124 | -7.806          | 43.03%   | 0.785 | 0.99510     | ORCL -$38,590.19 | 46 / 46           |
| C4_timed    | —            | —            | —      | —           | —      | —               | —        | —     | —           | SHOP -$33,176.84 | 1 / 46            |
| C4_brackets | —            | —            | —      | —           | —      | —               | —        | —     | —           | SHOP -$35,868.02 | 1 / 46            |
| C4_ungated  | —            | —            | —      | —           | —      | —               | —        | —     | —           | —                | 0 / 46            |
| C5          | $4,750.21    | -$4,371.21   | 0.320  | $11,043.01  | 0.196  | 7.116           | 49.00%   | 1.076 | 0.15998     | SMH $7,170.48    | 2 / 2             |
| C6          | —            | —            | —      | —           | —      | —               | —        | —     | —           | SHOP -$31,147.81 | 1 / 46            |
| C7_equal    | —            | —            | —      | —           | —      | —               | —        | —     | —           | SHOP -$15,440.01 | 1 / 48            |
| C7_tilt     | —            | —            | —      | —           | —      | —               | —        | —     | —           | SHOP -$19,271.17 | 1 / 48            |

At blind 5 bp, standalone sleeve correlations were close to zero (OR5/reversion −0.025,
OR5/Noise −0.011, reversion/Noise −0.031), but low correlation did not overcome sleeve losses or missing exits.
The JSON contains the standalone and actual-book sleeve matrices with matched resolved-session counts, as well
as worst LOSO and the 10,000-draw stationary bootstrap at every cost and window. The p-values are descriptive,
not corrected for multiple comparisons; the stitched C5 p-value at 5 bp (0.04150) does not supersede the blind
p-value (0.15998).

Blind 5 bp closed-leg attribution uses the preregistered pre-2016 large-cap group (including QQQ and SMH),
2019-or-later regular-way listings (not just IPOs), and other names:

| Candidate   | Pre-2016 large caps / ETFs | 2019-or-later listings | Other names  |
| ----------- | -------------------------- | ---------------------- | ------------ |
| C1          | -$17,197.86                | $0.00                  | -$96,775.90  |
| C2          | -$8,186.67                 | -$15,194.38            | -$14,554.71  |
| C3_3R       | -$8,190.07                 | -$17,374.48            | -$23,228.22  |
| C3_top2     | -$6,553.69                 | -$6,902.14             | -$20,776.48  |
| C4_timed    | -$7,287.90                 | -$12,227.22            | -$1,951.82   |
| C4_brackets | -$7,054.34                 | -$14,698.94            | -$3,770.11   |
| C4_ungated  | -$22,832.10                | -$32,813.74            | -$164,192.22 |
| C5          | $17,311.01                 | $0.00                  | $0.00        |
| C6          | -$7,964.61                 | -$14,432.26            | -$11,417.45  |
| C7_equal    | $574.93                    | -$9,114.86             | -$5,482.39   |
| C7_tilt     | -$1,662.48                 | -$10,647.90            | -$7,764.78   |

C5's gain comes entirely from its two pre-2016 ETFs. Later listings did not salvage OR5 or reversion. These are
attributed contributions, not reruns with point-in-time universe membership. Causal eligibility excludes pre-listing
activity, but a 2026 roster still omits historical delistings and is survivorship-biased.

## Data and provenance

The first Wave 4E archive matched only 45 of the 62 frozen names and was never scored. The
[committed exact-62 receipt](blind-archive.json) admits all 62 names and verifies positive bar coverage for all
59 names listed by 2023-12-29. ALAB, GEV and SNDK were not yet listed. The corrected calendar is byte-identical
to the original frozen calendar. The archive rows reconcile to:

| Segment              | Physical rows | Regular and listed | Outside exact RTH | Outside regular-way listing during RTH |
| -------------------- | ------------: | -----------------: | ----------------: | -------------------------------------: |
| 2016–2023 blind      |     8,641,719 |          7,787,173 |           811,914 |                                 42,632 |
| 2024–2026 continuity |     3,923,737 |          3,480,548 |           442,813 |                                    376 |

The first scoring invocation stopped in decompression, before replay. The published object contains one valid
174,597,176-byte gzip member followed by 1,693 nonmember bytes. The pre-score framing receipt pins the byte
boundary, verifies SHA-256 and length of the **entire** 174,598,869-byte S3 object, and decodes the member.
The member has every manifest-declared row, including the expected per-symbol counts. No row was trimmed to
recover the archive. The scorer then completed one chronological replay with the registered LOSO and bootstrap
calculations, without refitting.

Reproduce metadata admission from the repository root with the mounted artifact credentials:

```sh
bun services/bayn/tools/research-8yr-unseen-intraday-oos.ts --audit
```

[results.json](results.json) pins the published scoring revision, both tape receipts and the frozen protocol
digest. It records all 11 candidate variants × 3 costs × 11 windows, active-roster counts by year, first eligible
stock dates, per-symbol attribution, and all 33 session-aligned equity series (with explicit nulls).

For later reproduction, check out the reviewed squash commit with current `origin/main` history available locally
and run `--score --output <new-file.json>`. The scorer checks the frozen digest and confirms that the published
scorecard binds the same archive before opening either tape. Such a reproduction is not a new blind test.
