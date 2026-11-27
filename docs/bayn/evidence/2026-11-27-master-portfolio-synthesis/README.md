# Bayn Wave 4C: Cross-horizon portfolio and cash-carry synthesis

**Research only. No promotion, broker mutation, or capital authorization.** This is a retrospective
account simulation, not an independent finding of alpha. The portfolio budgets below are hypotheses to
shadow, not optimized weights or instructions for committing capital.

[Machine-readable results](results.json) include every portfolio × friction × sizing × cash scenario.
The comparison window is the **729 exact common sessions, January 2, 2024–November 25, 2026**. The
standalone daily panels cover 2,741 sessions from January 4, 2016 (S1, S2 and SP100) and 1,482 from
January 4, 2021 (S3). There is no synthetic zero-fill of an unavailable intraday history. The optional
2016–2023 intraday cross-check was not run.

## Results

Compounded account with SHY carry, January 2024–November 2026. The last column measures the _same-window_
difference against compounded passive benchmarks; none of the dual-horizon books beat SPY in this window.

| Portfolio          |  Net, realistic / base / harsh / brutal | Realistic CAGR | IR vs SHY |  MaxDD | Excess over SHY / 60:40 / SPY, realistic |
| ------------------ | --------------------------------------: | -------------: | --------: | -----: | ---------------------------------------: |
| P1 · three engines |   $69.85k / $63.78k / $48.47k / $32.91k |         20.10% |      2.39 |  3.90% |           +$59.11k / +$34.88k / +$14.13k |
| P1 · two engines   |   $76.92k / $70.31k / $54.82k / $40.80k |         21.80% |      2.05 |  4.31% |           +$66.18k / +$41.95k / +$21.20k |
| P1 · upgraded v2   | $37.75k / $13.94k / −$22.52k / −$49.82k |         11.71% |      0.73 | 12.91% |            +$27.01k / +$2.78k / −$17.98k |
| P1 · live v2       | $39.55k / $21.00k / −$13.04k / −$24.67k |         12.21% |      0.85 |  9.73% |            +$28.80k / +$4.58k / −$16.18k |
| P2 · overnight     |   $19.12k / $18.87k / $17.60k / $15.51k |          6.24% |      0.48 |  7.44% |            +$8.38k / −$15.85k / −$36.60k |
| P3 · dual core     |   $44.95k / $42.29k / $35.17k / $27.08k |         13.69% |      1.52 |  6.73% |            +$34.21k / +$9.98k / −$10.77k |
| P4 · dual full     |   $45.08k / $42.54k / $35.53k / $27.97k |         13.73% |      1.50 |  5.55% |           +$34.33k / +$10.11k / −$10.65k |
| P5 · preservation  |   $30.50k / $28.87k / $24.48k / $19.87k |          9.64% |      1.78 |  1.88% |            +$19.76k / −$4.47k / −$25.23k |

- **Low measured cross-horizon correlation did not create a return premium for the mix.** The fixed, zero-carry
  S1/S4, S1/S5 and S3/S4 correlations at realistic friction were **−0.059, +0.050 and +0.005**. S1/S2 was
  **+0.815**. Combining sleeves reduced dependence on a single signal family, not necessarily drawdown:
  P3 had a larger MaxDD than pure S4. P3 and P4 beat 60/40 through harsh stress, but not brutal stress.
  P4 added just **$124** over P3 at realistic friction, with more components to operate.
- **The shared cap bound.** Compounded realistic P3 scaled on **five** sessions, peaking at **$180k reserved**.
  Its stationary-bootstrap MaxDD VaR/CVaR were **8.32% / 9.64%** and its excess-SHY p-value was **0.0029**.
  P5 used at most **$79.1k reserved**, with a **3.61% / 4.16%** MaxDD tail and the lowest observed drawdown,
  at the expense of lower terminal P&L. Neither conditional tail nor p-value accounts for strategy selection.
- **The long-window and cost effects differ.** Fixed S1 made **$53.38k / $46.82k** without cash carry at 5/10 bp
  ETF spread across 2016–2026. At realistic friction its **$58.11k** zero-carry P&L became **$64.44k** with carry
  (**+$44.40k** versus passive SHY). S2 turned over **3.68×** capital per year one-way at realistic fixed sizing.
  S3’s fixed zero-carry 2021–2026 P&L was **$51.75k** at realistic friction and **$48.68k** at harsh friction.
  The v2 variants were much more friction-sensitive: both lost money outright at harsh and brutal stress.

## Signals and fixed allocation

| Sleeve | Replay contract                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1     | Wave 3C signed 120d trend at 10% vol; HYG-above-SMA50 rotation by 120d momentum/vol; −5-session pension rebalance at a 2% spread; unfiltered turn of month (−2 through +4, 15% vol); SMA100/RSI(2) <15, RSI >70 or 7-session exit. Blend with Wave 3C’s 60-session inverse-vol budgets (5-session refresh, 2% floor, independently marked 10 bp paper books). |
| S2     | S1’s signed trend and HYG rotation only, same lagged allocator, with one-third of the resulting notional. The lower turnover is a budget constraint, not a new signal fit.                                                                                                                                                                                    |
| S3     | Wave 2A’s 46-stock `momentum/open-open/expanded-stocks/60/60/4/10/1/0`: 60-return/60-fit SPY residual score, skip one, 4 long + 4 short, 10-session refresh, prior-close share sizing and WDC corporate-action exit.                                                                                                                                          |
| S4     | Wave 3B’s three-engine OR5 tilt (50%/25%/25%): RVOL ≥2.5/past ATR gap/2R Top-1, noon relative-VWAP IQR ≥100 bp 2L+2S to the last 5m open, and 30m QQQ+SMH Noise Area (1.2 band/opposite exit). S4-two omits Noise Area and uses 75%/25%.                                                                                                                      |
| S5     | Wave 2B’s 21-symbol concurrent fixed-size v2 architecture, 25/50 bp entry/stop-limit collars, t+2 minutes and live brackets. Live-v2 is the 10/10 bp collar control. Both reuse the frozen 1m archive and retained strategy, eligibility and planner logic without changing the policy.                                                                       |

The formulas come from [Wave 2A](../2026-11-27-5yr-daily-overnight-alpha/README.md),
[Wave 2B](../2026-11-27-3yr-sip-bayn21-v2/README.md), [Wave 3A](https://github.com/proompteng/lab/pull/16366),
[Wave 3B](https://github.com/proompteng/lab/pull/16365) and [Wave 3C](https://github.com/proompteng/lab/pull/16367).
Those studies did not promote these portfolios. Wave 2A's Train-leading candidate was a different 17-stock rule;
the mission’s S3 uses the specified expanded-stock probe, not that candidate. W4C keeps signal histories across
split boundaries but starts each evaluation account flat, marks to the final close, and does not invent a final
liquidation. Its continuous account P&L therefore is not a sum of the prior studies’ split-liquidated results.

| Portfolio | Overnight budget | Intraday budget                                          |
| --------- | ---------------- | -------------------------------------------------------- |
| P1        | None             | 100% S4; separate S4-two, S5 and Live-v2 controls        |
| P2        | 100% S1          | None; S1’s standalone panel is P2 over the longer window |
| P3        | 100% S1          | 50% S4                                                   |
| P4        | 70% S1 + 30% S3  | 50% S4                                                   |
| P5        | 60% S2           | 40% S4                                                   |

Budget percentages are multipliers on standalone position sizing, not simultaneous shares of fully invested
capital. S4 and v2 are alternatives here, not two independently funded intraday accounts. For example, 60% S2 is 20% of the uncapped two-arm signal book before account limits.

## Account, friction and attribution

- Begin with $100,000. Fixed mode requests $100,000-based sizes; losses still constrain buying power.
  Compounded requests use the previous session’s ending equity. Signed positions retain their shares until
  a signal changes, a scheduled rebalance occurs, or a risk trim is needed. P&L is marked close to close
  through observed opens, including gap P&L. SP100 uses the original prior-close sizing convention.
- The overnight cap is the lesser of $150,000 and 2× available risk equity, with at least 50% initial margin
  and [Alpaca’s price-dependent maintenance schedule](https://docs.alpaca.markets/us/docs/margin-and-short-selling)
  applied to the modeled positions. Intraday headroom is the lesser of $180,000 less overnight open gross
  and 4× previous-close maintenance excess (no 4× below $25,000). New simultaneous intraday orders share
  one proportional reduction at the reservation boundary; the ledger records constrained dates, including
  any pre-scale attempt beyond $180,000. No intraday orders are added in an overnight-held symbol.
- The $150,000 cap applies after next-open sizing and after close risk trims. A price gap can move a previously
  admitted position through a limit before a trim; opening gap breaches are recorded separately. The $180,000
  result is **reserved** gross at simulated entries, using overnight opening marks, not continuous real-time
  marked gross. The tape does not have synchronized intraday quotes for every overnight ETF. Price-through risk,
  risk-trim executability, security-specific house rules, intraday working-order overlap, locates, hard-to-borrow
  fees, size/impact and forced liquidations require independent paper or quote replay.
- Round-trip bps (seven hyper-liquid ETFs / other ETFs / stocks): **1/2/3**, **2/2/5**, **5/5/10**, **10/10/15**.
  The seven are SPY, QQQ, TLT, GLD, IEF, SHY and HYG. Charge half each side, 0.21 bp only on sells and
  1.5% ACT/365 on prior-close short gross. The modeled long debit is 6.5% ACT/360 on unfinanced prior-close longs
  (no reuse of restricted short proceeds); earn no carry on pledged gross. Flat-overnight intraday has no
  overnight borrow or long debit. These are assumptions, not measured NBBO or historical fee schedules.
- Cash sensitivities credit zero or the **adjusted SHY close-to-close return on previous-close unencumbered
  cash**. SHY is a short-duration Treasury ETF proxy, not a 3-month bill or guaranteed broker cash interest.
  The proxy has price risk, can be negative, and is not a funded SHY trade, so no SHY overlay order is sent.
  Real accounts need explicit sweep, collateral and settlement terms. Benchmarks are frictionless adjusted
  buy-and-hold SHY and SPY, and daily constant-weight 60% SPY / 40% IEF. Terminal dollar and CAGR differences
  measure account-level excess, not factor-adjusted alpha. Fixed-mode IR and beta normalize P&L by $100,000;
  compounded statistics normalize by prior equity.
- Stationary bootstrap: 10,000 seeded circular resamples, geometrically distributed blocks of mean five
  sessions. The one-sided p-value tests centered **paired daily excess over SHY**; the largest 5% of
  resampled raw-return path drawdowns determine MaxDD VaR/CVaR. This is a conditional sensitivity,
  not trial-adjusted statistical significance or a future tail guarantee. CAGR uses 252 sessions/year.
  Ex-Top-5 removes only the five largest positive dollar days. Sortino uses a zero minimum return;
  `sortinoVsShy` uses paired SHY excess. Undefined statistics are null.

## MMC → MRSH and holdout status

[Marsh announced on December 29, 2025](https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html)
that MMC would become MRSH on January 14, 2026. The archived universe contains MMC through January 13 and **no
MRSH bars**. This run first reproduces the original held-position January 14 missing-open failure. It then
replays the frozen Wave 3A `momentum-120-120-21-10-sector-2` using two explicit treatments:
a pre-announced January 13 close exit and ban on subsequent MMC orders, and a full-history **ex-MMC** sensitivity
that re-ranks the remaining financial stocks. Neither imputes a successor execution or treats the ticker as a
zero-return investment. The exit is an evaluation rule, not repaired vendor history. RTX’s prior reset is retained.
All prior Train, Validation and Holdout windows are descriptive. At the harsh 5/10 bp ETF/stock tier
(fixed notional, no carry), the causal-exit and ex-MMC holdouts made **+$4,487 and +$4,607**, respectively,
but **−$1,957 and −$1,904** Ex-Top-5. Their 2016–2026 P&L was **−$4,974 and −$5,092**, and the historical
2022–2023 Validation losses persisted (**−$18,681 and −$18,208**). Closing the data gap makes the Holdout
scoreable; it does not reverse the Validation veto.

## Prospective shadow and paper gates

1. Freeze one primary configuration and one comparator before observing the next unstudied session. P3 vs P5
   is a useful _testable comparison_ of two dual-horizon mixes; P1/S4 and SHY are controls. Do not select a
   new winner or change the weights, thresholds, cash proxy or fees on the evaluation tape.
2. Collect at least **120 consecutive new regular sessions**, including all opens/half-days and every skipped
   order. Authenticated quotes and broker paper receipts must reconcile signal cutoff, quote time and NBBO,
   order size, fill, locate status, open/close holdings, DTBP/Reg T, and cash/interest for each session.
   Require zero unresolved marks or exits, zero overnight leakage from intraday, and zero cap/collision breaches.
   Record roll-forwards for corporate actions with point-in-time ticker mapping; halt affected signals if evidence
   is unavailable.
3. Before a separate, authorized paper rollout decision, require positive net excess versus SHY and positive
   Ex-Top-5 under base and harsh costs, no observed negative implementation shortfall beyond the registered
   cost budget, and drawdown inside the predeclared loss budget (for this comparison, 10% peak-to-trough).
   A sample with fewer than 20 down-SPY sessions or no stressed spread/borrow days is not sufficient to assess
   those regimes; extend without retuning. Failure or incomplete evidence means no promotion. Shadow and paper
   success do not grant a live-capital mandate.

## Reproduce

An artifact identity is pinned by SHA-256, raw and compressed byte lengths, row count, symbol coverage and the
regular-session calendar. The 2016–2026 daily tape is total-return adjusted; the 62-symbol multiyear daily and
intraday tapes are split adjusted. Ex-dividend cash flows for the split-adjusted stock sleeve are not measured.
The fixed 1m v2 archive is necessary for authentic minute decision windows; upsampling the 5m bars would create
information that was never observed.

With existing read access to the named artifact bucket and endpoints:

```sh
report_dir=$(mktemp -d)
bun services/bayn/tools/research-master-portfolio-synthesis.ts --output "$report_dir/results.json"
bunx oxfmt --config .oxfmtrc.json "$report_dir/results.json"
cmp "$report_dir/results.json" docs/bayn/evidence/2026-11-27-master-portfolio-synthesis/results.json
rm -r "$report_dir"
```

The date axis is shared within each panel. Split comma-delimited `equityCentsCsv` rows and divide by 100 for
USD. The overlap benchmark curves use the same representation. Exposure date fields are CSV (empty means none).
All metrics and correlations are calculated before currency rounding. The exact byte receipts and v2 identity are
under `input`; the calendar-year attribution and risk statistics are under each run’s `metrics`.
