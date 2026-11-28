# Wave 8A: macro ETF core and the dual-horizon account

The shared-account replay covers **2,741 sessions from 2016-01-04 through 2026-11-25**. It is a
retrospective comparison on frozen SIP data, not a new blind experiment or a prospective trading
qualification. No parameter was selected from the results, and no strategy activation is proposed.

[SUMMARY.json](SUMMARY.json) contains all 27 cost/portfolio results, calendar-year returns, seven windows,
paired bootstrap results, input and ledger hashes, turnover and capacity checks. See the
[production contract](../../macro-etf-core-architecture.md) for the underlying pure module.

## What was tested

| Portfolio | Overnight                                                             | Intraday        |
| --------- | --------------------------------------------------------------------- | --------------- |
| B0        | Passive SHY total-return mark                                         | —               |
| B1        | Passive SPY total-return mark                                         | —               |
| E1        | 100% F2                                                               | —               |
| E2        | 100% F4                                                               | —               |
| I1        | SHY sweep                                                             | 100% QQQ+SMH C5 |
| P1        | 100% F4                                                               | 100% C5         |
| P2        | 100% F2                                                               | 100% C5         |
| P3        | 50% F2 + 50% F4, rolled into one macro target on their common cadence | 100% C5         |
| P4        | 50% F4 + 50% Wave 5D O1, separate registered review rules             | 100% C5         |

O1 is available on the same ETF archive; no conservative substitute is needed. B0/B1 are frictionless marks
at every tier (as in Wave 5C), not modeled execution. Their turnover includes the initial allocation; there is no
terminal liquidation. All traded portfolios start with $100,000 and reinvest in one account. Whole shares refer
to adjusted-price research units. The source does not provide historical unadjusted shares and cash dividends as
separate cash flows.

## Results

### 10 bp one-way stress tier

| Book | Final equity |   CAGR | Δ CAGR vs SHY | Δ equity vs SHY | Sharpe | Sortino |  MaxDD | Calmar | Turnover/yr |    2022 | Positive years | Ex-top-10 Δ vs SHY | p vs SHY |
| ---- | -----------: | -----: | ------------: | --------------: | -----: | ------: | -----: | -----: | ----------: | ------: | -------------: | -----------------: | -------: |
| B0   |     $120,024 |  1.69% |      +0.00 pp |              $0 |   1.09 |    1.69 |  5.70% |   0.30 |       0.05× |  -3.88% |           9/11 |           +0.00 pp |        — |
| B1   |     $421,019 | 14.11% |     +12.42 pp |       +$300,995 |   0.84 |    1.18 | 33.79% |   0.42 |       0.05× | -18.18% |           9/11 |         +109.57 pp |   0.0029 |
| E1   |     $276,319 |  9.78% |      +8.09 pp |       +$156,296 |   0.91 |    1.28 | 18.98% |   0.52 |       1.84× |   1.15% |          10/11 |          +81.93 pp |   0.0022 |
| E2   |     $197,817 |  6.46% |      +4.77 pp |        +$77,793 |   1.21 |    1.68 |  9.81% |   0.66 |       0.83× |  -1.53% |           9/11 |          +50.59 pp |   0.0005 |
| I1   |      $32,877 | -9.71% |     -11.40 pp |        −$87,146 |  -1.47 |   -1.98 | 68.68% |  -0.14 |      98.73× |  -4.88% |           0/11 |          -93.45 pp |   1.0000 |
| P1   |     $181,862 |  5.64% |      +3.95 pp |        +$61,839 |   1.00 |    1.39 |  9.78% |   0.58 |       7.16× |  -1.77% |           8/11 |          +35.00 pp |   0.0058 |
| P2   |     $249,602 |  8.76% |      +7.07 pp |       +$129,579 |   0.77 |    1.09 | 19.95% |   0.44 |       9.44× |   1.18% |           9/11 |          +58.01 pp |   0.0095 |
| P3   |     $224,620 |  7.71% |      +6.02 pp |       +$104,597 |   0.93 |    1.30 | 14.04% |   0.55 |       5.98× |  -0.86% |           8/11 |          +56.94 pp |   0.0032 |
| P4   |     $172,838 |  5.15% |      +3.46 pp |        +$52,814 |   0.87 |    1.20 | 14.84% |   0.35 |       8.64× |   0.98% |           9/11 |          +25.14 pp |   0.0222 |

### Split excess and cost sensitivity

Each split cell is rebased dollar excess over passive SHY at 10 bp per side. The JSON includes the complete
risk and return metrics at each cost. The 2024–2026 window is the same 729-session window as Holdout.

| Book | Final equity, 2 bp | Final equity, 5 bp |   Train Δ | Validation Δ | Holdout Δ | 2016–2023 Δ |   2022 Δ |
| ---- | -----------------: | -----------------: | --------: | -----------: | --------: | ----------: | -------: |
| B0   |           $120,024 |           $120,024 |        $0 |           $0 |        $0 |          $0 |       $0 |
| B1   |           $421,019 |           $421,019 | +$153,616 |      +$3,122 |  +$44,983 |   +$161,978 | −$14,291 |
| E1   |           $281,642 |           $279,690 |  +$61,930 |     +$13,815 |  +$31,765 |    +$85,517 |  +$5,034 |
| E2   |           $200,034 |           $199,192 |  +$31,290 |      +$7,759 |  +$20,666 |    +$42,155 |  +$2,355 |
| I1   |           $158,154 |            $97,647 |  −$65,598 |     −$12,383 |  −$22,885 |    −$70,959 |    −$996 |
| P1   |           $199,573 |           $194,178 |  +$16,419 |      +$8,292 |  +$23,813 |    +$26,777 |  +$2,119 |
| P2   |           $274,630 |           $266,114 |  +$38,989 |     +$15,147 |  +$36,325 |    +$61,338 |  +$5,062 |
| P3   |           $241,079 |           $235,359 |  +$35,713 |     +$11,445 |  +$29,108 |    +$52,233 |  +$3,022 |
| P4   |           $195,543 |           $188,700 |  +$12,731 |      +$9,490 |  +$19,595 |    +$24,227 |  +$4,869 |

### What changed when the books shared capacity

- **Standalone F2 and F4 beat SHY in all three splits at every cost.** At 10 bp per side, F2 had the
  higher CAGR (9.78%) and was up 1.15% in 2022. F4 had lower full-period drawdown (9.81%) and ran at
  0.83×/year turnover on the full span. Its Train turnover was 0.93×/year; the <0.9× full-period result
  is not a ceiling on each split under the shared model. SPY beat all books on absolute full-period CAGR.
- **Noise did not improve terminal equity over its matching F2 or F4 book at any cost.** At 2 bp per side
  I1 placed 2,410 fills, versus 142–237 across the combined books. Between 2,337 and 2,433 attempts were
  blocked by same-symbol overnight holdings in each mix at that cost. A low standalone correlation is
  not evidence of additive P&L under a shared gross and coexistence rule.
- **Cost sensitivity is material.** I1 beat SHY at 2 bp per side and fell below it at 5 and 10 bp.
  Every combined book beat SHY in each of the three splits at all three tiers, but this does not
  validate the overlay independently or establish forward profitability.

### Sleeve correlations at 10 bp per side

| Series                 |    Full | SPY drawdown days (2,318 sessions) |
| ---------------------- | ------: | ---------------------------------: |
| I1                     | +0.0183 |                            +0.0191 |
| P1                     | -0.0031 |                            -0.0122 |
| P2                     | +0.0076 |                            +0.0037 |
| P3                     | -0.0118 |                            -0.0163 |
| P4                     | +0.0201 |                            +0.0124 |
| F2 vs standalone Noise | -0.0226 |                            -0.0383 |
| F4 vs standalone Noise | -0.0161 |                            -0.0368 |

B0/B1/E1/E2 have no intraday leg, so their within-book correlation is undefined.

## Replay and accounting

- **Oracle checks precede scoring.** Wave 5C [#16379](https://github.com/proompteng/lab/pull/16379) independently
  generated the reference digest of the ordered signal/execution dates and every weight (12 decimal places)
  for 63 F2 and 63 F4 reviews. Wave 6C [#16381](https://github.com/proompteng/lab/pull/16381) supplied the
  119-review O1 oracle, mapped into the same symbol order. The unshared fixed-size C5 identity check,
  with no carry, reproduces $41,848.66 blind and $67,164.47 stitched at the original **2 bp round trip**.
  That check is not a reported 2 bp one-way portfolio result.
- **Data:** The runner streams directly from the frozen Rook-Ceph `agents-artifacts` bucket. Four manifests,
  both official session calendars, every compressed byte, available raw hashes, and decoded row counts
  are pinned. The blind tape decodes the one complete gzip member (174,597,176 bytes); the 1,693-byte
  suffix is included in the full-object hash but is not fed to the decompressor. It retains all 8,641,719
  data rows before roster selection. Daily adjusted bars are admitted only for the frozen 29 ETF roster;
  XLC inception and two XLRE gaps are explicit, not filled. The separate 5m tapes are split-adjusted.
- **Time:** T-1 macro closes set the next-open action; old positions earn the overnight gap before trades.
  A prior-close 10% aggregate band controls F2/F4; O1 retains its 5% per-symbol review band. C5 uses
  the first 30m signal, 14 completed prior sessions, 1.2× gap-aware bands, next 5m open entries and
  opposite-band exits, and the last 5m open at or before close minus two minutes for timed exits. It
  carries complete history across the 2023/2024 seam. The two selected ETFs need no execution supplement.
  A missing Noise entry mark cancels that attempt; a booked exit without a mark aborts the replay.
- **One account:** Funded SHY consumes gross. Sweep available capital at startup and macro rebalances;
  the standalone intraday account also re-sweeps after flattening. Same-symbol overnight orders are
  netted, sells settle before buys, and held overnight symbols cannot take a Noise entry. Whole-share
  C5 sizes scale the $60k per-symbol cap and $1,500 ATR risk budget with equity, subject to shared capacity.
- **Margin:** The frozen Wave 6C model applies a $150k/2× equity overnight ceiling and $180k combined
  entry-reserved gross. It uses 4 × (prior-close equity − maintenance), floored at zero and disabled below $25k, as additional
  intraday buying power, with
  [Alpaca price-tier maintenance](https://docs.alpaca.markets/us/docs/margin-and-short-selling)
  and the [historical DTBP rules](https://docs.alpaca.markets/us/v1.1/docs/user-protection).
  Reserve all opening overnight gross, including SHY, and release intraday capacity only at modeled exits,
  before new entries at the same slot. Long debit costs 6.5% ACT/360; intraday positions are flat overnight.
  Open/close cap trims are executed at those adjusted marks. This is a historical limit model, not a claim
  of tick-level compliance or implementation of Alpaca's
  [newer intraday-margin methodology](https://docs.alpaca.markets/us/docs/the-intraday-margin-rule).
  Point-in-time house restrictions, short availability, auction realizability, market impact, and true
  spreads are not on these tapes.
- **Costs and statistics:** Charge 2/5/10 bp **per side**, plus 0.21 bp on sell proceeds, and debit financing.
  Sharpe uses daily returns (zero cash hurdle) with √252 annualization; Sortino uses RMS downside relative
  to zero. One-way turnover is half of executed gross dollars divided by prior equity, annualized with
  252 sessions. Split returns and excess dollars rebase to $100k without resetting holdings; CAGR uses
  elapsed calendar time. Ex-top-10 removes the strategy's ten best positive days and the matched SHY
  days before compounding. Correlation uses daily net sleeve contributions (including SHY in overnight);
  a SPY drawdown day means its close is below the running high, not just a negative day. Correlations with
  a flat leg and the B0-vs-itself significance test are undefined (`null`). The 10,000-resample one-sided
  stationary bootstrap is centered on paired daily arithmetic excess over SHY, mean block length 10;
  nominal p-values are not multiple-testing-adjusted.

## Reproduce

In the cluster runner with the existing `agents-artifacts` secret mounted, run from the repo root:

```sh
bun services/bayn/tools/research/macro-etf-core-dual-horizon.ts --output /tmp/macro-etf-core-summary.json
bunx oxfmt /tmp/macro-etf-core-summary.json
cmp /tmp/macro-etf-core-summary.json docs/bayn/evidence/2026-11-27-macro-etf-core-dual-horizon/SUMMARY.json
```

The runner reads `AGENTS_ARTIFACTS_ENDPOINT`, `AGENTS_ARTIFACTS_BUCKET`, and the mounted AWS key variables.
It needs no broker credentials and does not alter any remote object. Any oracle, archive hash, row count,
calendar, booked price, P&L reconciliation, or capacity mismatch prevents publication of a summary.
