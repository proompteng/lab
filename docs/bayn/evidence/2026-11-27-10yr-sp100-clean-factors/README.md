# Bayn Wave 4I: clean ten-year SP100 factor results

**Decision: promote none.** All 85 registered candidates failed the development vetoes. None of the
11 preselected diagnostics cleared the full research gates on the sealed 2024–2026 Holdout either.
The observed crash controls improved some outcomes, but did not establish crash resistance or investable alpha.
No policy, broker path, capital authorization, or migration changed.

## What the tapes proved

- The source contained 450,712 rows and 2,741 sessions. Excluding all 2,522 historical MMC rows removed the
  [January 2026 rename](https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html)
  gap from every split. The replay covered 137 equities and exactly 27 ETFs. Of retained equities, LIN started on
  2018-10-31; the other 136 have a bar on every session. XLC started on 2018-06-19 and XLRE missed two sessions.
  UUP was not in the frozen manifest. No proxies were used.
- No frozen center, probe, or sector exclusion used the diagnostic last-bar fallback. The preregistered RTX exit
  and missing/discontinuous execution cases are regression-tested separately.
- All frozen centers stayed below 6× annual one-way turnover in every split. Low turnover and lower cost
  did not overcome weak returns outside the best days or pass the statistical gates. The stationary bootstrap used
  10,000 draws and cumulative DSR counted 445 trials, including 360 from Wave 3A.
- This is a fixed, retrospective stock/sector roster and Wave 3A ([#16366](https://github.com/proompteng/lab/pull/16366))
  already exposed the same market interval. Freezing prevented Wave 4I tuning on Holdout scores; it did not make
  those dates independent or prospective.

## Across the splits

P&L in USD on $100,000: **zero-cash net / excess over buy-and-hold SHY with idle cash earning SHY**, at 10 bp
round trip plus sell fees and borrow. The 20 bp column is Holdout SHY excess.

| Frozen center                 |             Train |        Validation |           Holdout | Holdout 20 bp excess |
| ----------------------------- | ----------------: | ----------------: | ----------------: | -------------------: |
| 52-week high, long            | +60,743 / +54,919 |   +7,139 / +7,052 | +22,448 / +13,985 |              +12,515 |
| 52-week high, regime hedge    | +55,988 / +49,788 |   +4,990 / +5,215 | +21,461 / +12,904 |              +11,415 |
| 52-week high, dollar-neutral  | −55,759 / −63,233 | −15,086 / −15,183 |   +1,146 / −9,803 |              −11,522 |
| 52-week high, sector-neutral  | −15,514 / −23,042 | −11,457 / −11,572 |  −3,088 / −14,042 |              −15,523 |
| Quality trend, long           | +58,033 / +52,205 |   +2,119 / +2,050 | +21,403 / +12,922 |              +12,269 |
| Quality trend, beta hedge     |   +1,523 / −6,162 | −15,416 / −15,540 |  −1,296 / −11,738 |              −12,996 |
| Quality trend, sector-neutral | −11,992 / −19,273 | −23,615 / −23,977 |   +2,935 / −8,000 |               −9,376 |
| Crash-managed momentum        | +40,353 / +35,087 |       +285 / −451 |  +17,372 / +9,727 |               +8,710 |
| Trend-filtered BAB            |     +2,285 / −434 |     +364 / +1,361 |  +11,267 / +6,564 |               +5,857 |
| ETF trend                     | +34,319 / +29,184 |       +903 / +105 | +26,092 / +16,363 |              +16,071 |
| Quality trend + 25% ETF       | +52,104 / +46,447 |   +1,815 / +1,563 | +22,575 / +13,777 |              +13,214 |

### What failed and why

- **52-week high:** At 10 bp, the SPY/HYG-triggered hedge reduced the long book's 2022 zero-cash loss from
  $2,050 to $1,359, but neither book made money in absolute terms that year. Both books lost money in Validation
  after removing the best five days on an excess basis. Both neutral books lost money against SHY in Validation
  and Holdout. The long results do not establish a market-neutral premium.
- **Quality trend:** The unhedged book made $4,990 over SHY in 2022 and then lost $3,092 against SHY in 2023.
  Its Holdout 10 bp excess was $12,922 at 2.26× annual one-way turnover; p = 0.180 and DSR = 0.055.
  Neither the beta hedge nor the sector-neutral book improved the evidence for a durable premium.
- **Crash-managed momentum and BAB:** At 10 bp both beat SHY in 2022, then lost $3,582 and $7,217,
  respectively, against SHY in 2023. The BAB book's Holdout SPY beta was 0.004 on an excess basis, but both
  managed books were negative after removing the five best Holdout days at 10 and 20 bp. The trend filter
  restricted short entries and covered recovering shorts; it did not eliminate rebound losses.
- **ETF trend and the mix:** The standalone ETF diagnostic lost $5,033 against SHY in 2022 (−$8,772 with SHY carry,
  before subtracting buy-and-hold SHY). The mix held up better: 2022 10 bp net was +$36 without carry, −$1,254
  with carry and +$2,485 against SHY. At 20 bp it did not clear the 2022 absolute-net gate, and it lost $1,073
  against SHY in 2023 at 10 bp. Holdout SHY-excess Sharpe was 0.598 for the mix at 10 bp, max drawdown 11.47%,
  bootstrap p = 0.131 and DSR = 0.078. It passed all 11 sector exclusions and the Holdout plateau, but removing
  its ten best days turned 10 bp SHY-excess P&L into a $635 loss. Standalone ETF trend had positive ex-top-10
  Holdout excess at both stress costs; its 10 bp p = 0.111, DSR = 0.094 and 2022 loss still vetoed it.

At 10 bp the exact same-session, SHY-excess correlation of the standalone equity and ETF sleeves in the mix
was **0.7612817525908334** in Train, **0.4961358255270597** in Validation and **0.46749297337430457**
in Holdout. It was **0.3946586662765454** in 2022, so the overlay was not a negatively correlated crisis hedge.
The extra diversification did not make the combined strategy investable.

### Holdout cost and cash sensitivity

Net USD rounded to the nearest dollar. The excess column subtracts the same $10,960 untraded,
buy-and-hold SHY P&L, not merely the interest on the strategy's remaining cash.

| Sleeve            | RT bp | Zero idle carry | SHY idle carry | Excess over SHY |
| ----------------- | ----: | --------------: | -------------: | --------------: |
| ETF trend         |     2 |          26,325 |         27,556 |          16,595 |
| ETF trend         |     5 |          26,238 |         27,468 |          16,508 |
| ETF trend         |    10 |          26,092 |         27,323 |          16,363 |
| ETF trend         |    20 |          25,801 |         27,031 |          16,071 |
| Quality + 25% ETF |     2 |          23,025 |         25,187 |          14,227 |
| Quality + 25% ETF |     5 |          22,856 |         25,019 |          14,058 |
| Quality + 25% ETF |    10 |          22,575 |         24,737 |          13,777 |
| Quality + 25% ETF |    20 |          22,012 |         24,175 |          13,214 |

## Evidence and reproduction

1. [Protocol and pricing sources](protocol.md) were pushed in
   [`8462d3bc3`](https://github.com/proompteng/lab/commit/8462d3bc3b2f9f0fc8be9f6e729bc5d96e6c9a8f).
2. The [development freeze](freeze.json) was committed and pushed in
   [`87cc50131`](https://github.com/proompteng/lab/commit/87cc50131822672c547efa3016fffc7b65436c14), before scoring.
   It binds the dataset, exact source versions, 85-trial ledger hash, centers, probes and DSR references.
3. The single [scoring result](results.json) contains all 11 calendar years for each center, every split,
   all four cost levels and three cash/benchmark views, all 11 GICS exclusions per split, probe and plateau
   results, drawdown/Calmar/SPY diagnostics, and stationary p/DSR for the centers. Its aligned daily standalone
   sleeve series and SHY prices permit independent correlation and cash-benchmark verification. The
   `developmentLedger` records every registered candidate, including those not scored on Holdout.

Download the two named S3 objects from the [protocol](protocol.md) to a private directory using the mounted
read-only credentials. The two study commands used on the registered branch, in order, were:

```sh
bun services/bayn/tools/research-10yr-sp100-clean-factors.ts --freeze --input-dir "<dataset directory>"
# Commit and push freeze.json before the next command.
bun services/bayn/tools/research-10yr-sp100-clean-factors.ts --score --input-dir "<dataset directory>"
```

The retained study refuses another score. To inspect evidence without reopening the sample:

```sh
jq '.finalists[] | select(.slot == "combined") | .splits[] |
  {split, annualExcess: (.yearly | map_values(.costs["10"].shyExcess.netUsd)),
   vetoes}' docs/bayn/evidence/2026-11-27-10yr-sp100-clean-factors/results.json
```
