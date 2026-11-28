# Bayn Wave 2A: five-year daily and overnight alpha

**Decision: do not promote.** None of the 848 registered variants passed the development gates. The strongest
Train candidate, next-Open 17-stock residual momentum, made **$30,075** net on Frozen Holdout at 10 bp,
with **2.27 Sharpe**, **$21,330 ex top five days**, and **1.87% mean daily one-way turnover**. It lost **$3,448**
on Validation (**−$12,732 ex top five**) and its Holdout Deflated Sharpe Ratio was **0.250** against a **0.95**
gate. The promising holdout is not permission to override the veto. No strategy module, live policy hash,
or migration was changed.

## What was tested

The [pre-registered protocol](protocol.md) pins the SIP daily tape and all strategy, selection and accounting
rules. The 87,727 rows cover 62 symbols and 1,482 SPY sessions from January 4, 2021 to November 25, 2026.
The actual session counts are **877 Train / 293 Validation / 312 Frozen Holdout**. We excluded 531 ambiguous
or pre-regular-trading rows (423 COHR, 102 SOFI, 6 SNDK). Missing history remained missing. WDC positions
were flattened at the last close before its SanDisk distribution, and return windows reset after it.

- Equity variants use the exact **50 named** and **18 live Bayn Morning/Midday** cohorts, plus the **46** and
  **17** stock-only controls. The named cohorts include ETFs; they are not 50 and 18 single-name stocks.
- ETF variants cover **16** ETFs and the **four supplied live ETFs**. Six live ETF 3+3 rotation trials were
  structurally rejected. The 12 survivors-only ensemble slots had fewer than two eligible family incumbents;
  the 12 diagnostic ensembles were measured, not substituted for those slots.
- The [development-only commit](https://github.com/proompteng/lab/commit/5cb855efb189ce62eecb04453d2cbddbabb281c5)
  contains [the freeze receipt](freeze.json) and the ledger before any Holdout scoring. It pins two Train-ranked,
  Validation-vetoed diagnostics and exactly 24 Holdout evaluations, including cohort and one-step plateau
  probes. The [final ledger](results.json) retains all variants and failures. Null Holdout entries were not scored.

### Execution and family comparison

The two frozen diagnostics enter at **next-day Open**, with order quantities fixed from the preceding Close,
and rebalance Open-to-Open. The close-to-close variants use a **hypothetical same-Close MOC fill**: an order
cannot be sized from the completed closing print and also be submitted for that auction. The overnight family
also tests actually pre-submittable MOC signals lagged one Close. The gap-reversal test with a current opening
gap and that same Open fill is diagnostic for the analogous reason. All prices are auction proxies, not evidence
of fills, available size, or locates.

Best **Train-Sharpe** row in each named lane, with its fixed Validation outcome at 10 bp. These are development
comparisons, not additional Holdout selections.

| Family                         | Execution                            | Train Sharpe | Validation Sharpe | Train mean one-way turnover |
| ------------------------------ | ------------------------------------ | -----------: | ----------------: | --------------------------: |
| Residual overnight momentum    | Same-Close → Open (diagnostic)       |        −1.20 |             −0.49 |                       46.5% |
| Residual overnight momentum    | Lagged signal MOC → Open             |        −1.29 |             −0.93 |                       47.7% |
| Multi-day residual momentum    | Same-Close → Close (diagnostic)      |         0.67 |             −1.78 |                        8.9% |
| Multi-day residual momentum    | Next-Open → Open                     |         0.87 |             −0.29 |                        3.4% |
| Residual reversal              | Same-Close → Close (diagnostic)      |        −0.10 |              0.35 |                       27.6% |
| Residual reversal              | Next-Open → Close, prior gap         |        −0.13 |             −2.01 |                       42.0% |
| ETF time-series trend          | Next-Open → Open                     |         0.62 |              0.08 |                        6.1% |
| ETF relative-strength rotation | Next-Open → Open                     |        −0.13 |             −1.41 |                       10.1% |
| Expanded Train-leader ensemble | Mixed, 20-session inverse volatility |        −0.25 |             −1.00 |                       31.0% |

The 20-session expanded diagnostic ensemble lost $3,534 on Train and $5,307 on Validation after netting
actual simulated orders; using its 18-name counterpart did not fix this ($1,771 and $3,591 losses respectively).
Overnight holding alone did not reduce turnover: opening and closing the basket every day consumed nearly its
0.5x gross budget in daily round-trip-equivalent turnover. Ten-session Open-to-Open momentum cut turnover
substantially, but that improvement did not make its economics stable.

## Frozen diagnostics at 10 bp

Dollar figures are additive on a fixed $100,000 base and include 10 bp round trip, 0.21 bp on sells, and
1.5% annualized actual/365 borrow on close-held short notional. LOSO is minimum net P&L after excluding one
tradable symbol and rerunning the strategy. Plateau is the number of passing/available one-step neighbors;
at least two must be available. Full-precision detail is in the ledger.

| Frozen candidate                                                         | Split          |     Net | Ex-top-five net | Sharpe |  BootP |      DSR | Minimum LOSO | Plateau |  MaxDD |
| ------------------------------------------------------------------------ | -------------- | ------: | --------------: | -----: | -----: | -------: | -----------: | ------: | -----: |
| Residual momentum, 17 stocks; 60-return/60-fit, skip 1, 4+4, 10 sessions | Train          | $35,840 |         $16,791 |   0.87 | 0.0605 | 0.000066 |      $11,960 |     3/4 | 16.34% |
| Same                                                                     | Validation     | −$3,448 |        −$12,732 |  −0.29 | 0.6332 | 0.000316 |      −$5,394 |     0/4 | 10.13% |
| Same                                                                     | Frozen Holdout | $30,075 |         $21,330 |   2.27 | 0.0023 | 0.249537 |      $24,346 |     4/4 |  4.70% |
| ETF trend, four live ETFs; 10-return, 5 sessions                         | Train          | $21,820 |         $11,565 |   0.62 | 0.1080 | 0.000011 |      $20,005 |     0/1 |  7.99% |
| Same                                                                     | Validation     |  $1,031 |         −$8,529 |   0.08 | 0.4674 | 0.001307 |      −$1,775 |     0/1 |  8.40% |
| Same                                                                     | Frozen Holdout |    −$83 |        −$10,922 |  −0.01 | 0.5103 | 0.000668 |      −$4,114 |     0/1 | 10.13% |

The equity diagnostic's 10 bp Holdout Calmar was 5.17, but it made $45,095 on up-SPY sessions and lost
$15,020 on down-SPY sessions (SPY beta 0.177). The ETF diagnostic made $2,742 on up-SPY sessions and lost
$2,825 on down-SPY sessions (SPY beta −0.123, Calmar −0.007). DSR used the full 848 registered trials and
a Train-derived daily null benchmark of 0.18154, without reducing the trial count for correlation.

| Frozen Holdout cost | Momentum net / ex-top-five | ETF trend net / ex-top-five |
| ------------------- | -------------------------: | --------------------------: |
| 2 bp RT             |          $30,541 / $21,796 |            $1,869 / −$9,049 |
| 5 bp RT             |          $30,366 / $21,621 |            $1,137 / −$9,752 |
| 10 bp RT            |          $30,075 / $21,330 |             −$83 / −$10,922 |
| 20 bp RT            |          $29,492 / $20,747 |          −$2,523 / −$13,264 |

| Calendar year, 10 bp | Sessions | Momentum net | ETF trend net |
| -------------------- | -------: | -----------: | ------------: |
| 2021                 |      252 |      $28,728 |       −$1,109 |
| 2022                 |      251 |     −$10,701 |        $9,086 |
| 2023                 |      250 |       $4,217 |       $11,376 |
| 2024                 |      252 |      $15,863 |           $24 |
| 2025                 |      250 |       $9,542 |        $3,147 |
| 2026 through Nov 25  |      227 |      $14,817 |          $245 |

### Does expanding the universe help?

For the frozen momentum parameters, stock-only expansion raised Validation Sharpe from −0.29 to 1.22,
but reduced Train Sharpe from 0.87 to 0.33 and Holdout Sharpe from 2.27 to 1.23. Exact mixed-cohort
expansion similarly helped Validation (−0.57 → 1.21) but weakened both other splits. These are the same
parameters, not the best configuration re-selected on each cohort.

| Fixed configuration and cohort | Train Sharpe / ex-top-five | Validation Sharpe / ex-top-five | Holdout Sharpe / ex-top-five |
| ------------------------------ | -------------------------: | ------------------------------: | ---------------------------: |
| Momentum, 50 named             |               0.33 / −$912 |                   1.21 / $5,567 |                0.85 / $3,148 |
| Momentum, exact 18 live        |             0.82 / $14,511 |                −0.57 / −$17,653 |               2.21 / $19,572 |
| Momentum, 46 stocks            |                 0.33 / $83 |                   1.22 / $6,034 |                1.23 / $9,264 |
| Momentum, 17 live stocks       |             0.87 / $16,791 |                −0.29 / −$12,732 |               2.27 / $21,330 |
| ETF trend, 16 ETFs             |              0.54 / $8,388 |                −1.31 / −$21,242 |               0.07 / −$7,713 |
| ETF trend, four live ETFs      |             0.62 / $11,565 |                  0.08 / −$8,529 |             −0.01 / −$10,922 |

## Reproduce

From the repository root with Bun 1.4.2 and the existing `agents-artifacts` S3 credentials (or add
`--input /path/to/pinned.tsv.gz`):

```sh
# Recompute the committed development results before scoring the same sealed Holdout.
bun services/bayn/tools/research-5yr-daily-overnight-alpha.ts --score \
  --freeze-commit 5cb855efb189ce62eecb04453d2cbddbabb281c5
```

For a new development-only reproduction, use `--freeze` from the engine revision before the freeze
commit. The command refuses to overwrite an existing receipt. `--score` requires the original development
commit to be available in Git. First scoring requires its exact engine, receipt and development ledger.
Once results are committed, the command is read-only: it allows source changes such as shared-statistics
refactoring only when the development ledger, every other receipt field and the scored ledger all reproduce
byte-for-byte. The input gzip is not committed.

**Limit:** the tape fixes prices and coverage, not the point-in-time investable universe, dividend cash flows
or short liabilities, auction execution, liquidation capacity, or borrow availability. Do not treat any
Holdout row as prospective evidence from here on. Testing a new hypothesis requires a separately registered,
untouched sample rather than another selection on this one.
