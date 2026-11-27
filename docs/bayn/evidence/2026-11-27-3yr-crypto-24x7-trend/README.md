# Bayn Wave 2E: no qualifying 24/7 crypto engine

**Do not promote.** None of 280 registered long/flat Alpaca spot variants earned a Frozen Holdout nomination or
cleared the final gates. Fifteen hourly variants were net positive in all three splits at 50 bp round trip, but
none cleared the full holdout gate. No daily variant was net positive in Frozen Holdout at 50 bp. The study adds
no strategy module or deployment binding and preserves the live policy hash and migrations.

The [protocol](protocol.md) was committed before development was evaluated. The [development-only receipt](freeze.json)
was separately committed at `56d775bf2bd83e07495ad9ed765e93bdb7a8001e` before loading holdout prices.
[Results](results.json) contain every trial and the BTC/USD and 10-coin passive benchmarks at 50/30/20 bp, on
each split, each available calendar year, and the registered regimes. The strongest development rank within each
group is a diagnostic, not a substitute for a nominee.

Review reproduced a stale channel/compression watermark that could reopen a position without a new breakout
after missing data. The correction clears state when sizing evidence disappears. The
[development-only correction receipt](freeze-correction.json) was committed before rerunning the score. It binds
the corrected source and original receipt, keeps the same grid, gates, and nomination/diagnostic IDs, and
records the corrected development ranking separately. The
[original score](https://github.com/proompteng/lab/blob/48e8ba9708d8b05900bb4786e57821c8edc88b6f/docs/bayn/evidence/2026-11-27-3yr-crypto-24x7-trend/results.json)
remains in Git. The corrected replay repairs implementation evidence; it is not a second independent holdout.

## What ruled the engine out

| Frame and rule                        | Trials | 50 bp: positive Train + Validation | Also pass development economics + plateau¹ | Positive all splits at 50 / 30 / 20 bp |
| ------------------------------------- | -----: | ---------------------------------: | -----------------------------------------: | -------------------------------------: |
| 1H channel / ATR                      |     36 |                                 12 |                                          0 |                           12 / 18 / 23 |
| 1H EMA                                |     12 |                                  0 |                                          0 |                              0 / 0 / 0 |
| 1H risk parity, core and full         |     48 |                                  6 |                                          0 |                              3 / 3 / 3 |
| 1H cross-sectional momentum           |     32 |                                  0 |                                          0 |                              0 / 0 / 0 |
| 1H compression, with/without weekends |     24 |                                  0 |                                          0 |                              0 / 0 / 0 |
| 1D channel / ATR                      |     36 |                                 31 |                                          0 |                              0 / 0 / 0 |
| 1D EMA                                |     12 |                                  9 |                                          1 |                              0 / 0 / 0 |
| 1D risk parity, core and full         |     48 |                                 48 |                                          9 |                              0 / 4 / 8 |
| 1D cross-sectional momentum           |     32 |                                  1 |                                          0 |                              0 / 0 / 0 |

¹ Before the regime or cross-frame checks. All ten daily configurations in this column failed to qualify on the
development regime checks. Zero of 280 passed the Frozen Holdout economic, plateau and bootstrap gates together,
even when counted descriptively without the nomination requirement.

- **Channel and EMA:** The (development-ranked) 1H channel/4×ATR diagnostic returned **+1.74%, +0.56%, +3.11%**
  in Train, Validation and Holdout at taker fees. Holdout drawdown was only 0.07× BTC and annual gross turnover
  was 9.60× NAV (~2.40% annualized fees), but holdout net without its best five days was **−3.79%**, raw block
  p was **0.2673**, and DSR was **0.0645**. Omitting any coin kept its holdout net positive; eight of ten omissions
  kept Validation positive. Neither the headline return nor LOCO resolves the best-day dependence.
- **Risk parity:** At 50 bp, median holdout net for the 10-coin versus BTC/ETH/SOL grid was **+3.17% vs −0.66%**
  on 1H, and **−5.13% vs −10.18%** on 1D. The broader roster lowered median annual turnover on both frames
  (2.68× vs 3.59× hourly; 3.30× vs 4.52× daily). That improved the comparison, not qualification. The daily
  development-ranked parity rule had +19.26% Train and +9.87% Validation but −3.08% Holdout. Only one of its
  ten coin omissions had positive 50 bp holdout net.
- **Cross-sectional momentum:** Three- and seven-day rebalancing did not reliably keep rotation cheap. The
  hourly development-ranked row turned over **53.73× NAV/year** in Holdout (~13.43% annualized taker fees).
  It returned +24.84% in Holdout, **−23.28%** excluding its five best days, and −6.71% in Validation.
- **Compression and weekends:** No hourly compression trial had a positive Frozen Holdout at any of the
  three fee rates, even before requiring cross-frame evidence. Lowering fees alone did not rescue the family.

## Bull and bear evidence at 50 bp

Net / annualized daily Sharpe / max drawdown. The selected regime dates and an explicit, fee-matched
buy-and-hold control matter: smaller losses during a crash are not equivalent to a positive Calmar ratio.

| Frame, fixed window | BTC buy-and-hold         | Equal-weight buy-and-hold | Trials passing all regime criteria |
| ------------------- | ------------------------ | ------------------------- | ---------------------------------: |
| 1D 2022 bear        | −64.33% / −1.29 / 66.99% | −64.83% / −1.18 / 67.94%  |                            0 / 128 |
| 1D 2024 bull        | +119.98% / 1.74 / 26.63% | +217.90% / 1.57 / 41.70%  |                           42 / 128 |
| 1H 2024 bull        | +120.43% / 1.74 / 32.43% | +192.98% / 1.54 / 48.07%  |                           15 / 152 |
| 1D 2026 Q1 pullback | −22.01% / −1.41 / 35.25% | −28.56% / −1.59 / 42.57%  |                            0 / 128 |
| 1H 2026 Q1 pullback | −22.21% / −1.43 / 35.73% | −28.93% / −1.60 / 43.49%  |                           11 / 152 |

No daily trial had positive Calmar in the 2022 bear or the 2026 Q1 pullback. Cash and small exposure reduced
drawdown but did not turn either bear window into a profitable one. During the daily holdout, BTC and the
equal-weight basket lost 44.41% and 62.52%; daily risk parity's smaller losses still failed absolute acceptance.

## Data limits and reproduction

The manifest hashes match. Each file includes 10 bars at the exclusive November 27 cutoff, which are counted
but not scored. There are hourly BTC gaps, hourly SOL starts August 26, 2024, daily XRP starts January 1, 2024,
and daily SOL has a long gap from July 2023 into August 2024. The receipt and results retain per-coin coverage;
the portfolio does not invent bars, forward-fill signals, or trade stale prices. Sizing indicators burn in on
observed bars; there is no pre-2022 history for warming up the first daily split. The fee-only open/close replay
is not evidence of executable liquidity or maker fill rates; adding real spread/slippage could worsen results.
Alpaca's schedule identifies the requested 20 bp maker scenario as Tier 3, not Tier 4.

Reproduce from the PR revision or a checkout containing its squash merge, using the existing read-only S3
credentials. On the original branch the scorecard matches byte for byte. A squash changes the two
checkout-history IDs that identify where the receipt files first appeared. Compare everything else, including both receipt hashes and both frozen
source registration IDs:

```sh
set -eu
expected=docs/bayn/evidence/2026-11-27-3yr-crypto-24x7-trend/results.json
scratch=$(mktemp -d)
trap 'find "$scratch" -maxdepth 1 -type f -delete; rmdir "$scratch"' EXIT
bun services/bayn/tools/research-3yr-crypto-24x7-trend.ts --score --output "$scratch/results.json"
jq -cS 'del(.freezeCommit, .correction.commit)' "$expected" > "$scratch/reference.json"
jq -cS 'del(.freezeCommit, .correction.commit)' "$scratch/results.json" > "$scratch/replay.json"
cmp "$scratch/reference.json" "$scratch/replay.json"
```

`results.json` carries the original and corrected source registrations, receipt commits and digests, all nine selection
records, all fee/window metrics, neighbor IDs and passes, coverage, and leave-one-coin-out tuples keyed by
excluded coin and fee. The tuple order is declared in the file. All compounded returns and drawdowns in JSON
are decimals; turnover is a NAV multiple. Undefined diagnostics are `null`, not passes. Any follow-on
discovery must register a new experiment and find an independent holdout; do not reuse these shadows as
proof of an edge.
