# Wave 18D registration: sector ETFs and intraday expansion

**Research only.** Measure the economics of expanding the QQQ/SMH Noise Area book and of trading ranked sector
opening gaps. No cash carry, order, policy, entitlement, or activation changes. Freeze the rules and trial roster
before computing returns; no variant is selected or refit on Holdout. The price periods have been used in earlier
research: Holdout here is a chronological test of the Wave 18D rules, not a new unobserved market sample.

| Split      | First session | Last session | Sessions |
| ---------- | ------------- | ------------ | -------: |
| Train      | 2016-01-04    | 2021-12-31   |    1,511 |
| Validation | 2022-01-03    | 2023-12-29   |      501 |
| Holdout    | 2024-01-02    | 2026-11-25   |      729 |

Use the original [Wave 6A](../2026-11-27-10yr-16etf-noise-area/protocol.md) split-adjusted Alpaca SIP
5-minute tapes and calendars, with their published byte receipts. The three absent symbols (XLB, XLP, XLU)
come from a separate raw Alpaca SIP 5-minute capture, pinned by its manifest and compressed/raw SHA-256.
The manifest SHA-256 is `c53674d014b0d3d70f90a574746a8ea90ecf75fbac057e88903b590cbeee9cd0`.
For XLB and XLU divide pre-2025-12-05 prices by two and multiply volume by two, matching their
[issuer-confirmed 2:1 splits](https://www.ssga.com/library-content/products/fund-docs/etfs/us/information-schedules/select-sector-spdr-fund-share-splits-faq.pdf).
Use only regular-session bars. Do not displace a row of any frozen tape. From the frozen adjusted daily archive
use only ratios internal to its price series, not cross-source price levels. Retain all 2,741 official sessions,
including early closes, and carry prior features, never positions, over split seams. The first 60 sessions
are cash warmup for all books, including the control; fixed-size statistics retain those zero-return dates.

## A — Noise Area expansion (11 trials)

- Universe ladder: **B0** (QQQ/SMH), **B0+XLK**, **B0+XLK+IWM**, then add **Top3** or **Top6** of the
  remaining eight sector ETFs. The broad diagnostic **All13** adds all eight and SPY to the fixed four.
  Rank the eight by the mean of complete split-adjusted RTH dollar-volume sums (5-minute VWAP × volume)
  over the preceding 60 official sessions; require at least 55 complete days for each name. Rank once at
  the first eligible 2016 session and once before each later year's first session; ties break by ticker.
  A failed election withholds the entire top-K book for that year. No ranking by strategy returns.
- For each expansion rung compare inverse standard deviation (diagonal equal risk) with covariance equal risk.
  For two positive weights, equal contributions imply the same ratio as inverse volatility, so register B0 once.
  Estimate sample covariance of the previous 14 official open-to-close returns. Floor individual variance
  at (0.001)² and halve off-diagonals
  for covariance sizing. Both books have $100,000 of gross entry budget before signals. A missing sizing
  history withholds the book; non-signaling allocations stay cash. Use Wave 6A whole adjusted-share sizing,
  capped by both the decision close and the adverse opening fill at the largest scenario cost. This is a
  bar simulation, not pre-order knowledge of the executable quote.
- Use Wave 6A's first strict breakout (no reversal or re-entry) at 30-minute checkpoints, with first at
  10:00 and last at 15:00 or close minus 30 minutes. Use 1.4× the mean absolute move from open to matched
  checkpoint over the prior 14 sessions that reached it; anchor at max(open, prior RTH close) for the
  upper band and min for the lower. An absent eligible bar withholds that checkpoint; only scheduled early
  closes that never reached it can be skipped in the lookback. Entry uses the next bar open; do not retry
  missing entries. An opposite checkpoint close requests exit on the next open. Otherwise request exit at
  close minus 15 minutes. Use the first observed open at or after the request **no later than 15:50 ET**
  (12:50 ET on early closes). A later open cannot repair a missing exit.
- The common B0 control is the inverse-vol QQQ/SMH book under these clocks, warmup, and missing-history
  rules, not a reproduction of prior Wave 6A dollar totals. Report increments against it and against the
  immediately preceding rung with the same weighting.

## B — Sector opening-gap fade and continuation (32 trials)

Rank the nine sectors XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU and XLB each day by
`(today's 09:30 RTH open / prior RTH close − 1) / prior fractional ATR14`. Fractional ATR is the mean of
14 daily true ranges divided by each day's own preceding daily close, from the frozen adjusted daily tape.
Prior close location is `(close − low) / (high − low)` on the previous adjusted daily bar (0.5 for a flat
range). Do not mix a daily adjusted price with a split-only intraday price.

Use only the top **positive** and bottom **negative** ranks, breaking ties lexically, with no fallback
to a lower-ranked name if a filter fails. An incomplete input for any sector withholds the cross-section.
Compare these fixed axes:

| Axis                 | Registered values                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Horizon from open    | 30 min (exit 10:00 ET), 60 min (exit 10:30 ET)                                                                   |
| Direction            | Continuation buys the top gap and shorts the bottom; fade reverses the legs.                                     |
| Portfolio            | Dollar-neutral at raw entry (half gross per side, both legs required); long-only takes only the prescribed long. |
| Absolute gap         | Medium `[0.25, 0.75)` ATR; large `[0.75, ∞)` ATR.                                                                |
| Prior close location | Aligned: up-gap CLV ≥ 0.65, down-gap CLV ≤ 0.35; opposed: reverse the inequalities.                              |

Enter at 09:35 after the 09:30 bar completes, and exit at the exact horizon open. A missing required entry
withholds the entire book for the day; a missing exit for an entered leg is unresolved. Pair trades assume a
common open and use fractional shares for dollar neutrality before costs, not beta neutrality or a claim
that fractional shorts or simultaneous fills are available. Cash dividends remain part of split-only
observed price gaps; do not infer pure information shocks from the ranked gaps.

## Accounting, statistics, and gates

- Stress **0 / 2.5 / 5 / 10 bp round trip** with an adverse half on each raw fill and the same 0.21 bp sell
  fee as Wave 6A on the stressed sell price. Quantities do not change across cost points. Report signed
  breakeven as the zero of net P&L after the sell fee; a negative root means gross trading did not clear
  even zero slippage. Turnover is both raw fill notionals divided by $100,000, summed over the window.
- Capacity is a bar-liquidity proxy, not an execution limit: on each active session, take the minimum across
  entered and exited legs of the linearly scaled capital at which the fill would equal 1% of its 5-minute
  bar's observed dollar volume. Report the nearest-rank p10 and median over active sessions. It uses volume
  observed after the order, has no impact or quote model, and cannot certify executable size. No financing,
  locate, borrow, or additional fees are modeled. Compare conservative marked gross (sum of per-leg peaks
  with the worst adverse half-slip) to $180,000.
- Use annualized daily Sharpe (√252), percentage MaxDD on additive fixed-$100,000 equity, and Calmar
  (simple annualized return divided by MaxDD). Compare matched returns and Pearson correlation to B0 at
  the same cost, including cash days. A missing mandatory fill withholds the affected official statistics.
  Report held gaps and missing planned entries separately. If necessary, show a separate sensitivity
  excluding the exact same unresolved dates across all 43 books; never promote from the sensitivity.
- Use [Bailey–López de Prado DSR](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) with the sample
  dispersion of defined nonannualized Train Sharpes and exactly **43 registered trials**, including B0 and
  no-trade cells. Fit one benchmark per cost point using common resolved Train dates. Costs are fixed
  scenarios, not 176 selectable trials. Annual walk-forward uses the same frozen rules and a DSR reference
  expanded only through the prior year's last session; 2016 has no prior-year fit and 2026 is partial.
  The deflation covers this grid, not previous waves or correlated-spec effective multiplicity.
- Primary inference is at **5 bp**: one-sided, centered circular stationary bootstrap (10,000 draws,
  geometric mean block 5 sessions, seed `0x18d20261`, plus-one adjustment). Use identical resample plans
  for matched comparisons. Test A on daily excess over B0 and B on standalone returns; prior-rung and
  non-Holdout p-values are descriptive. Report all four costs with net, Sharpe, MaxDD, Calmar, DSR
  and aligned correlation.
- **PROMOTE** only as a candidate for separate prospective qualification. Require no unresolved exits,
  held-bar gaps, missed planned entries or gross-limit breaches over the full path; at least 30 active
  Holdout sessions; positive official Holdout net at 5 and 10 bp and after removing the ten highest
  positive days at 5 bp; DSR ≥ 0.95; and primary Holdout p < 0.05/42 (all noncontrol candidates).
  A must also improve Holdout Sharpe over B0. At least two of the three Holdout years must show positive
  incremental 5 bp net for A or positive standalone 5 bp net for B. Otherwise **DO NOT PROMOTE**.
  The unchanged B0 control is not a promotion candidate.
