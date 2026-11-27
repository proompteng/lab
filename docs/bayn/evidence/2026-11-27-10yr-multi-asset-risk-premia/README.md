# Bayn Wave 3C: Multi-asset ETF risk premia

**Decision: no promotion.** No sleeve or ensemble cleared the registered 10 bp gates on the 27-ETF,
2,741-session SIP dataset. The five-arm ensemble had positive net and Ex-Top-5 in all three partitions at 10 bp,
but its Holdout bootstrap p-value was **0.1381**, and at 20 bp its Holdout Ex-Top-5 turned **−$349**.
The run found a portfolio worth studying on new data, not a validated edge or an ultra-low-turnover strategy.
No production strategy module, policy hash change, migration, or trading authority results from this study.

The [protocol](protocol.md) and runner were committed at [`eee09d9c4`](https://github.com/proompteng/lab/commit/eee09d9c4ec822ae8948fd986472e8536da86326).
The [development-only freeze](freeze.json) was pushed at [`e021694cf`](https://github.com/proompteng/lab/commit/e021694cf3672ce556f4c1290d93632cd5134101)
before scoring Holdout. The freeze covers 102 individual trials and 20 ensemble configurations (one registered
blend and its 19 neighbors) at each of the three friction levels. The [scored ledger](results.json) links the
receipt and contains all 11 calendar years, split metrics, all 27 ETF omissions per candidate, and the
registered neighbor and correlation analyses. Only the locked representatives, blend, and their registered
diagnostics were opened on Holdout.

## 10 bp round trip, with zero return on idle cash

Dollar results include the sell fee and short borrow. Each period cell is **Net / Ex-Top-5 Net**. The plateau
count is neighbors meeting the net and Ex-Top-5 rule in all three periods; the threshold is two-thirds.

| Locked rule                                       |                 Train |           Validation |       Frozen Holdout |  Holdout p | Holdout DSR | All 27 LOEO positive |   Plateau |
| ------------------------------------------------- | --------------------: | -------------------: | -------------------: | ---------: | ----------: | :------------------: | --------: |
| Trend: signed, 120d, 10% vol                      |     $24,593 / $13,318 |     $5,256 / −$7,777 |     $10,833 / $2,816 |     0.2419 |       0.055 |         Yes          |       0/4 |
| Pension: −5, 2%, long laggard                     |     $12,617 / −$1,663 |      $11,215 / −$508 |     $3,916 / −$4,451 |     0.3345 |       0.036 |          No          |       0/3 |
| Turn of month: −2 through +4, unfiltered, 15% vol |     $31,879 / $13,963 |     $15,770 / $3,001 |      $435 / −$14,733 |     0.4950 |       0.012 |          No          |       0/4 |
| Pullback: SMA100, RSI < 15, RSI exit, unhedged    |      $14,665 / $1,654 |     $5,900 / −$4,424 |    $29,686 / $16,730 |     0.0166 |       0.361 |         Yes          |       0/5 |
| Rotation: 120d, HYG gate, no IWM                  |     $46,637 / $26,418 |    $25,796 / $13,308 |     $23,630 / $2,221 |     0.1802 |       0.071 |          No          |       1/3 |
| **Five-arm ensemble**                             | **$24,502 / $16,632** | **$12,408 / $5,446** | **$10,239 / $3,239** | **0.1381** |   **0.111** |       **Yes**        | **18/19** |

- Pullback was the only rule with Holdout p < 0.05, but it failed the Validation concentration gate and its plateau.
  Pension goes flat without either required leg, rotation goes flat without its HYG gate, and TOM loses money in
  Holdout without SPY. The ensemble's worst ETF removal still produced $12,112 Train, $4,945 Validation, and
  $5,202 Holdout net at 10 bp (the worst ETF varies by period).
- The sleeves were **not** uniformly orthogonal. Holdout off-diagonal correlations ranged from +0.08 to +0.50.
  Pension was the least correlated with the other four (all below +0.13), while trend/rotation reached +0.50
  and trend/pullback was +0.44. In Validation, trend vs. TOM was −0.28 and trend vs. pension was −0.12.
- At 10 bp the ensemble's Ex-Top-10 was $11,351 / $1,686 / −$1,522 (Train / Validation / Holdout).
  Holdout beta was 0.26, annualized alpha versus SPY −0.66%, max drawdown 8.10%, and Calmar 0.44.
  One-way turnover was 12.31× / 11.40× / 12.51× capital per year, above the 12× ceiling in two of three folds.

## Five-arm ensemble: friction and cash attribution

| RT slippage | Train Net / Ex-Top-5 | Validation Net / Ex-Top-5 | Holdout Net / Ex-Top-5 |
| ----------: | -------------------: | ------------------------: | ---------------------: |
|        5 bp |    $28,191 / $20,314 |          $13,542 / $6,561 |       $12,049 / $5,033 |
|       10 bp |    $24,502 / $16,632 |          $12,408 / $5,446 |       $10,239 / $3,239 |
|       20 bp |     $17,123 / $9,268 |          $10,141 / $3,215 |         $6,620 / −$349 |

| Period         | 10 bp, zero yield on idle cash | 10 bp, invest idle cash in SHY | Annualized Sharpe |
| -------------- | -----------------------------: | -----------------------------: | ----------------: |
| Train          |                         24.50% |                         22.69% |              0.76 |
| Validation     |                         12.41% |                         10.68% |              1.32 |
| Frozen Holdout |                         10.24% |                         12.06% |              0.62 |

These are fixed-capital returns, not compound growth rates. The idle-SHY overlay has its own turnover and sell fees;
its return may be higher or lower than the zero-cash case and never enters the gates.

| Ensemble year       | Sessions | 10 bp Net | 10 bp Ex-Top-5 | 20 bp Ex-Top-5 | 10 bp Sharpe |
| ------------------- | -------: | --------: | -------------: | -------------: | -----------: |
| 2016                |      252 |      $127 |        −$3,404 |        −$4,227 |         0.04 |
| 2017                |      251 |    $6,570 |         $3,338 |         $1,999 |         1.88 |
| 2018                |      251 |       $28 |        −$5,501 |        −$6,781 |         0.01 |
| 2019                |      252 |    $4,611 |          −$328 |        −$1,699 |         0.85 |
| 2020                |      253 |    $6,430 |          −$712 |        −$1,878 |         0.81 |
| 2021                |      252 |    $6,736 |         $1,843 |           $577 |         1.27 |
| 2022                |      251 |    $4,246 |        −$1,647 |        −$2,498 |         0.88 |
| 2023                |      250 |    $8,162 |         $3,333 |         $2,008 |         1.78 |
| 2024                |      252 |    $7,803 |         $1,891 |           $620 |         1.36 |
| 2025                |      250 |    $4,309 |        −$1,540 |        −$2,643 |         0.72 |
| 2026 through Nov 25 |      227 |   −$1,873 |        −$5,645 |        −$6,784 |        −0.39 |

To reproduce the locked results from the repository root, with read access to the pinned artifacts:

```sh
bun services/bayn/tools/research-10yr-multi-asset-risk-premia.ts --score
git diff --exit-code -- docs/bayn/evidence/2026-11-27-10yr-multi-asset-risk-premia/results.json
```

Do not run a new search against 2024–2026 and label it frozen. Next-open consolidated daily prices do not establish
spread, fill size, availability of short inventory, or achievable execution. Further candidate development would need
an unseen evaluation window and opening execution evidence before any profitability claim.
