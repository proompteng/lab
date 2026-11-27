# Bayn Wave 3A: no candidate qualified

None of the 360 registered trials earned positive net in both Train and Validation at both 10 and 20 bp. The two
trials positive in both splits at 10 bp were long-only ETF trend variants; neither survived 20 bp. All 324 tested
residual-momentum configurations lost money in Validation at 10 bp; its least-negative configuration still lost
$1,741. The specified four-sleeve risk-parity ensemble did not offset the Validation losses. There were no
development qualifiers, and no result on Holdout can reverse the veto. No strategy module, live policy, migration,
or order-routing change is warranted.

## Evidence and chronology

- [Pre-registered protocol](PROTOCOL.md) and [development-only receipt](freeze.json), committed with the
  [360-trial development ledger](development.jsonl) at `1bd2d4d797c8` before Holdout scoring.
- [Frozen results](results.json): 450,712 bars, 165 symbols, 2,741 sessions (including
  729 Holdout sessions), 5 frozen representatives and 30 distinct pre-authorized probes.
  The CLI reproduced the development receipt and ledger byte-for-byte before opening the Holdout tape. It did not
  screen other Holdout candidates.
- The 360 configurations include 344 single-sleeve configurations and 16 ensemble configurations (the one
  pre-specified blend plus its one-component substitutions). All were charged 5/10/20 bp RT, 0.21 bp on sell
  notional and 1.5% ACT/365 short borrow. The results are historical adjusted-bar simulations, not realized
  opening-auction returns or evidence of live short availability. Wave 2A already studied overlapping dates.

The long-only ETF trend representative cleared every Holdout check at both stress costs (net **$29,069 at 10 bp** and
**$27,247 at 20 bp**), but it lost $6,092 and $7,281 in Validation, respectively. Its Holdout gains do not qualify it.
It also remained exposed to the equity market and lost money on down-SPY days in aggregate; it did not demonstrate
the proposed crisis hedge.

The residual-momentum and ensemble representatives had unusable Holdout paths: each needed an opening price for
Marsh McLennan on January 14, 2026. The frozen manifest includes `MMC` but not its [successor ticker `MRSH`](https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html).
The engine rejected the split rather than inventing a fill or changing the universe after the freeze. Dashes
indicate unavailable economics, not zero; an invalid split suppresses its annual economics as well.

## Net P&L after all modeled costs

| Candidate         | Split      |     5 bp |    10 bp |    20 bp | Ex-5 at 10 bp | Ex-10 at 10 bp | Turnover/day |
| ----------------- | ---------- | -------: | -------: | -------: | ------------: | -------------: | -----------: |
| Residual momentum | train      |  $12,763 |   $9,061 |   $1,656 |        $1,848 |        -$4,225 |        4.90% |
| Residual momentum | validation | -$17,295 | -$19,093 | -$22,688 |      -$24,330 |       -$27,771 |        7.18% |
| Residual momentum | holdout    |        — |        — |        — |             — |              — |        6.23% |
| ETF trend         | train      |  $41,814 |  $40,413 |  $37,612 |       $30,100 |        $22,787 |        1.85% |
| ETF trend         | validation |  -$5,498 |  -$6,092 |  -$7,281 |      -$14,119 |       -$18,677 |        2.37% |
| ETF trend         | holdout    |  $29,979 |  $29,069 |  $27,247 |       $21,393 |        $15,170 |        2.50% |
| Sector reversal   | train      |  -$5,208 | -$26,052 | -$67,741 |      -$41,453 |       -$48,318 |       27.59% |
| Sector reversal   | validation |  -$7,504 | -$14,769 | -$29,300 |      -$21,022 |       -$25,105 |       29.00% |
| Sector reversal   | holdout    |   $2,476 |  -$8,301 | -$29,856 |      -$16,065 |       -$22,255 |       29.57% |
| Defensive         | train      |   $6,920 |   $5,187 |   $1,721 |       -$8,763 |       -$20,243 |        2.29% |
| Defensive         | validation | -$17,881 | -$18,483 | -$19,687 |      -$26,364 |       -$32,418 |        2.40% |
| Defensive         | holdout    |   $6,901 |   $6,163 |   $4,687 |       -$3,885 |       -$11,540 |        2.02% |
| Ensemble          | train      |  $14,819 |   $8,165 |  -$5,144 |        $2,482 |        -$1,671 |        8.81% |
| Ensemble          | validation | -$11,233 | -$13,688 | -$18,599 |      -$16,765 |       -$19,307 |        9.80% |
| Ensemble          | holdout    |        — |        — |        — |             — |              — |        9.69% |

## Risk, concentration and regime at 10 bp

The bootstrap tests positive mean net P&L, not a comparison to SPY. The DSR reference counts all 360 trials and is
not a gate. Regime columns report net dollars booked on up/down SPY Open-to-Open sessions; the first Open of each
split has no intra-split SPY mark. Machine evidence includes counts and the corresponding metrics at 5 and 20 bp.

| Candidate         | Split      | Ann. Sharpe | Max drawdown | Calmar | SPY beta | Up-SPY net | Down-SPY net | Bootstrap p |    DSR |
| ----------------- | ---------- | ----------: | -----------: | -----: | -------: | ---------: | -----------: | ----------: | -----: |
| Residual momentum | train      |        0.28 |        9.16% |   0.16 |    0.016 |    $15,185 |      -$6,124 |      0.2388 | 0.0998 |
| Residual momentum | validation |       -1.74 |       19.79% |  -0.49 |    0.006 |    -$9,884 |      -$9,132 |      0.9925 | 0.0002 |
| Residual momentum | holdout    |           — |            — |      — |        — |          — |            — |           — |      — |
| ETF trend         | train      |        0.84 |       12.05% |   0.56 |    0.342 |   $228,178 |    -$187,765 |      0.0146 | 0.5368 |
| ETF trend         | validation |       -0.47 |       14.46% |  -0.21 |    0.163 |    $48,338 |     -$54,380 |      0.7399 | 0.0375 |
| ETF trend         | holdout    |        1.12 |        7.09% |   1.42 |    0.382 |   $139,686 |    -$110,551 |      0.0225 | 0.7018 |
| Sector reversal   | train      |       -0.69 |       36.96% |  -0.12 |    0.025 |   -$10,954 |     -$15,098 |      0.9406 | 0.0002 |
| Sector reversal   | validation |       -1.16 |       14.90% |  -0.50 |    0.067 |     $4,728 |     -$19,421 |      0.9533 | 0.0027 |
| Sector reversal   | holdout    |       -0.41 |       11.81% |  -0.24 |   -0.018 |   -$13,104 |       $4,876 |      0.7824 | 0.0198 |
| Defensive         | train      |        0.08 |       15.00% |   0.06 |    0.109 |    $58,492 |     -$53,305 |      0.4226 | 0.0396 |
| Defensive         | validation |       -0.96 |       24.76% |  -0.38 |    0.100 |     $2,057 |     -$20,464 |      0.9083 | 0.0061 |
| Defensive         | holdout    |        0.21 |       18.68% |   0.11 |    0.170 |    $17,612 |     -$11,373 |      0.3734 | 0.1581 |
| Ensemble          | train      |        0.33 |        6.52% |   0.21 |    0.117 |    $69,160 |     -$60,995 |      0.2077 | 0.1241 |
| Ensemble          | validation |       -1.76 |       14.75% |  -0.47 |    0.082 |    $12,022 |     -$25,652 |      0.9924 | 0.0001 |
| Ensemble          | holdout    |           — |            — |      — |        — |          — |            — |           — |      — |

### Frozen Holdout verdicts

| Candidate         | Failed Holdout checks, 10 bp            | Failed Holdout checks, 20 bp            | Positive LOSO runs, 10 · 20 bp | Stable neighbors, 10 · 20 bp |
| ----------------- | --------------------------------------- | --------------------------------------- | -----------------------------: | ---------------------------: |
| Residual momentum | Net, Ex-top-5, Bootstrap, LOSO, Plateau | Net, Ex-top-5, Bootstrap, LOSO, Plateau |                    1/11 · 1/11 |                    0/8 · 0/8 |
| ETF trend         | None                                    | None                                    |                  11/11 · 11/11 |                    2/3 · 2/3 |
| Sector reversal   | Net, Ex-top-5, Bootstrap, LOSO, Plateau | Net, Ex-top-5, Bootstrap, LOSO, Plateau |                    0/11 · 0/11 |                    0/2 · 0/2 |
| Defensive         | Ex-top-5, Bootstrap, LOSO, Plateau      | Ex-top-5, Bootstrap, LOSO, Plateau      |                    9/11 · 9/11 |                    0/2 · 0/2 |
| Ensemble          | Net, Ex-top-5, Bootstrap, LOSO, Plateau | Net, Ex-top-5, Bootstrap, LOSO, Plateau |                    1/11 · 1/11 |                  0/15 · 0/15 |

A stable plateau requires at least two neighbors and at least two-thirds positive and retaining at least half of
the center's Sharpe. The receipt records separate Train and Validation exclusions and neighboring-parameter outcomes.

## Calendar-year net at 10 bp

| Year | Residual momentum | ETF trend | Sector reversal | Defensive | Ensemble |
| ---- | ----------------: | --------: | --------------: | --------: | -------: |
| 2016 |                $0 |        $0 |         -$7,323 |   -$5,942 |  -$3,206 |
| 2017 |              $316 |   $11,304 |        -$10,797 |    $8,997 |   $2,847 |
| 2018 |              $430 |   -$4,263 |         -$5,242 |   -$4,669 |  -$2,945 |
| 2019 |            $1,564 |   $14,248 |         -$4,355 |    $3,738 |   $4,043 |
| 2020 |            $5,200 |    $2,614 |         $10,762 |    $5,585 |   $6,373 |
| 2021 |            $1,551 |   $16,510 |         -$9,098 |   -$2,523 |   $1,053 |
| 2022 |          -$12,426 |   -$9,459 |         -$9,119 |   -$1,822 |  -$8,147 |
| 2023 |           -$6,666 |    $3,366 |         -$5,650 |  -$16,662 |  -$5,541 |
| 2024 |                 — |    $7,845 |         -$6,024 |   $10,674 |        — |
| 2025 |                 — |   $11,798 |             $45 |   -$5,396 |        — |
| 2026 |                 — |    $9,425 |         -$2,322 |      $885 |        — |

The full [results](results.json) report all 11 annual buckets at all three costs, using the same borrow and sell
fees, plus their drawdown, ex-top-5/10, Sharpe, Calmar, SPY regime, bootstrap and deflated Sharpe statistics.

## Reproduction

Run from the repository root. To independently reproduce the research mechanics, run the first command at the
preregistration source commit (before the receipt existed), then verify the generated development files against
the frozen commit. Run the second on that frozen commit before results exist. Use the existing authorized
agents-artifacts access or the two exact S3 objects in a directory passed as `--input-dir`.

```sh
bun services/bayn/tools/research-10yr-sp100-alpha.ts --freeze
bun services/bayn/tools/research-10yr-sp100-alpha.ts --score
```

The specified historical dataset is now opened for these candidates. A new promotion attempt needs genuinely
independent, previously unexamined evidence; selecting more configurations or relaxing thresholds on this
Holdout would not establish qualification.
