# Wave 4G: ten-year overnight vs. intraday auction study

**Decision: no promotion.** None of the 45 configurations met even the net, SHY-excess and ex-top-five gates
in every split at the 2 bp modeled auction cost, before applying 5/10 bp stress and statistical gates. The strongest
raw Holdout p-value at 2 bp was 0.0095 (Holm-adjusted p = 1.00); the largest Holdout DSR at 2 bp was
approximately 1.3e−30 under the frozen, all-cost Train deflation reference. There are no changes to live Bayn.

## Results

All dollar figures below are net at 2 bp round trip on a fixed $100,000 gross target, including sell fees and
borrow. The S&P 100 sample is a fixed set of 137 equities after removing MMC, not historical constituent
membership. The full 450,712-row tape records MMC's last bar on Jan 13, 2026 (before the Jan 14 ticker change);
no MMC or MRSH position was scored. XLC first appears June 19, 2018, and LIN Oct 31, 2018. XLRE has two
early gaps before it becomes eligible. No base configuration had a missing entry, late exit or overdue position.

| Configuration (2 bp)                       | Train net | Validation net | Holdout net | Holdout ex top 5 | Holdout vs SHY |
| ------------------------------------------ | --------: | -------------: | ----------: | ---------------: | -------------: |
| 60d sector spread, long (frozen stock leg) |   $95,014 |         $4,989 |     $34,440 |          $22,319 |        $24,199 |
| 20d overnight, long (largest Holdout net)  |   $87,572 |       −$14,843 |     $65,711 |          $44,741 |        $55,469 |
| Prior gap continuation (frozen gap leg)    |   $16,177 |         $2,535 |    −$13,087 |         −$28,467 |       −$23,329 |
| 27 ETF unfiltered overnight                |   $29,493 |       −$13,232 |     $22,944 |          $13,195 |        $12,702 |
| 27 ETF unfiltered intraday                 |  −$15,141 |        −$4,217 |    −$13,627 |         −$26,088 |       −$23,869 |
| Eight-anchor intraday (frozen ETF leg)     |  −$12,226 |          −$657 |    −$14,496 |         −$28,414 |       −$24,737 |
| Frozen ensemble                            |   $21,438 |         $1,796 |     −$3,768 |         −$10,582 |       −$14,009 |

- **Tug-of-war:** Across the 12 dollar-neutral sorts, the matched gross signs were positive overnight and negative
  intraday in 12/12 cases in Train, 7/12 in Validation, and 12/12 in Holdout. This supports a gross time-of-day
  pattern conditional on this universe, not a net market-neutral edge: none of the 12 had positive Holdout SHY
  excess at 2 bp. The long-only 20d variant earned $7,295 on Holdout at 10 bp but lost $2,946 versus SHY and
  $13,271 after removing its five best days. Five-/ten-session refresh changes memberships, not the requirement
  to cross both auction legs each night.
- **Gaps:** The frozen prior-gap continuation turned negative in Holdout and the 2 bp prior-gap fades all lagged
  SHY there. The realized same-open gap results are counterfactual and cannot authorize an opening-auction trade.
- **ETF premium:** Gross Holdout compounded overnight vs. intraday returns were +51.7% vs. +2.7% for SPY,
  +72.4% vs. −8.9% for QQQ, and +56.5% vs. −11.8% for IWM; TLT was −8.2% vs. +2.4%. SPY and QQQ had
  negative overnight and positive intraday gross returns in Validation. Down-SPY Holdout net for the 27-ETF
  book was −$48,677 overnight versus −$98,636 intraday at 2 bp: less downside in this replay, not protection.
  At 5 bp the overnight book earned $1,056 but lagged SHY by $9,186; at 10/20 bp it lost $35,425/$108,385.
  None of the SMA or credit filters met the multi-split gate.
- **Ensemble:** The frozen weights were 20.77% stock spread, 40.11% prior-gap continuation and 39.12% ETF
  intraday. Selection chose the ETF leg despite negative excess Sharpe in both development splits because it was
  the strongest under the registered minimum-split ranking. Holdout net was −$18,548, −$43,181 and −$92,448
  at 5, 10 and 20 bp; the blend did not rescue the standalone economics.

## Evidence and reproduction

- [Protocol](protocol.md) and [development receipt](freeze.json) were published in
  [`869be9554`](https://github.com/proompteng/lab/commit/869be9554568be3d08f322a5990b406db8176285)
  before any Holdout scoring. The receipt binds 330,646 development rows, the entire execution and scoring engine,
  and the selected legs, weights, and DSR reference. The scored [ledger](results.json) carries the same freeze SHA.
- The ledger preserves every configuration, all four costs, all three temporal splits, all eleven observed calendar
  years, and all relevant sector/ETF omissions. `pairedTugOfWar` is the matched gross same/opposite session check;
  `etfDecomposition` is an untraded gross attribution on paired dates. Neither is an extra searched strategy.
- The manifest and gzip stay in the mounted `agents-artifacts` S3 bucket at
  `bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Download both using the mounted AWS credentials to a
  private directory. To reproduce from the repository root without overwriting the published ledger, use the pre-score
  freeze SHA (the CLI fetches the named study branch and verifies its ancestry):

```sh
bun services/bayn/tools/research-10yr-overnight-tugofwar.ts --score \
  --freeze-commit 869be9554568be3d08f322a5990b406db8176285 \
  --manifest "$dataset_dir/MANIFEST.json" \
  --data "$dataset_dir/alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz"
```

## Limits

This is an OHLCV proxy backtest, not a fill study or an estimate of realized 2 bp slippage. The
[NYSE](https://www.nyse.com/trade/auctions) and [Nasdaq](https://nasdaqtrader.com/Trader.aspx?id=OpenClose)
auction rules require submission before the opening print; an opening-price gap cannot select that same fill.
Prior-gap MOO is executable in timing only and tests a different hypothesis. Establishing same-day gap alpha
needs time-stamped pre-cutoff indicative prices (or measured post-open execution), primary venue prints,
locates and capacity data. Independence from Bayn's production strategy would require timestamp-aligned
overlapping live exposures; this study does not measure it. The study's Holdout is now consumed and cannot
be reused to validate a retune.
