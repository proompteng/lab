# Bayn Wave 3A: pre-registered next-Open SIP study

## Data and chronology

Use only the pinned 450,712-row Alpaca consolidated SIP daily object (split and dividend adjusted; 138 named stocks
and 27 ETFs). The manifest's fixed sector map is not point-in-time S&P 100 membership. Late histories (including
XLC, LIN and MMC) need their own warmup; do not backfill them or invent pre-inception ETF proxies. This is a
survivor-selected, retrospective universe. Wave 2A ([PR #16358](https://github.com/proompteng/lab/pull/16358))
studied overlapping symbols and dates. The Wave 3A Holdout is sealed against selection within this study, not an
independent forward sample or an untouched market interval.

| Split          | First session | Last session | Sessions |
| -------------- | ------------- | ------------ | -------: |
| Train          | 2016-01-04    | 2021-12-31   |    1,511 |
| Validation     | 2022-01-03    | 2023-12-29   |      501 |
| Frozen Holdout | 2024-01-02    | 2026-11-25   |      729 |

Allocate windows only from data available at the decision close. History can warm across split boundaries; position
and cumulative P&L state cannot. Include cash/warmup dates in metrics. Start each split flat and liquidate at the
final Open; attribute Open-to-Open marks and entry/exit costs to the session when booked. If a symbol lacks close
history it is ineligible. Missing prices needed for fills or marks, or held Open-to-Open price ratios beyond
0.5–2.0, invalidate affected trials rather than fabricate execution evidence. No data-dependent exclusions after freeze.
One known data discontinuity is the April 3, 2020 RTX merger/spinoff: following the
[March 30 public announcement](https://investors.rtx.com/news-releases/news-release-details/raytheon-and-united-technologies-obtain-all-regulatory-approvals),
flatten the predecessor at the March 31 Open, block re-entry through the April 3 Open, and break the return history
across the event instead of pretending to capture the splice as alpha.

## Candidates

- **Residual momentum:** OLS with intercept on paired log returns (SPY and own GICS sector ETF), fit over 60/120/252
  sessions strictly before a 60/120/180-session residual formation window ending 5/10/21 sessions before the decision.
  Rank the formation sum of out-of-fit residuals relative to fitted residual volatility. Compare equal-dollar sector
  spreads of 1 or 2 names per leg per sector with unrestricted 10 or 15 per leg. Reset one of 5/10/21 equal tranches
  each session. Add a SPY overlay to cancel the estimated 60-session SPY beta; normalize including the overlay. Rebalance aggregate sides down to the smaller notional if a leg becomes ineligible.
  Scale gross on 126 sessions of realized, unscaled shadow-sleeve Open-to-Open volatility, targeting 10% annualized
  with multiplier 0.4–1.5 (1 before a usable estimate). Apply a further 0.4 multiplier when SPY is over 15% off
  its 252-session close high and trailing 20-session annualized vol exceeds 25%. This is a causal crash-state proxy,
  not an ex-post rebound signal or a coefficient replication of [Daniel and Moskowitz](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2371227).
- **Multi-asset trend:** Use the equal vote of the signs of 20/60/120/252-session adjusted-price returns. Threshold
  absolute votes at 0/0.25/0.5 (strictly greater), comparing long/short and long-only with cash for suppressed positions.
  Equal budget across seven asset-class groups; inverse 60-session volatility or inverse 60-session relative ATR
  within each group, floored at 25 bp daily. Replace one of five weekly tranches each day. This is the requested
  multi-horizon ETF adaptation of [Moskowitz, Ooi and Pedersen](https://fairmodel.econ.yale.edu/ec439/mosk.pdf), not
  a replication of their monthly futures portfolio.
- **Sector-neutral reversal:** Reverse the out-of-fit normalized 3/5-session residual using a preceding 60-session
  two-factor fit. Filter the new candidates whose latest absolute log return exceeds 3.5 times prior 60-session
  relative ATR. Hold one equal-dollar pair in each of the 10 strongest eligible sector spreads and replace
  one of 3/5 tranches per session.
- **Defensive:** Rank on low 60-session volatility or low SPY beta; 10/15 longs and shorts, equal-dollar stock
  spread plus the SPY hedge to neutralize estimated beta; replace one of 21 tranches each session.
- **Ensemble:** Combine the four frozen family representatives (including diagnostics if applicable). Weight inversely
  to trailing 126-session realized sleeve Open-to-Open volatility, floored at 5% annualized. The weights are
  computed at decision Close from completed intervals only. Net trades across sleeves before costs; do not add
  standalone sleeve P&Ls. Probe it by replacing exactly one sleeve with one of that sleeve's registered neighbors.

Mark adjusted-share equivalents (fractional theoretical units) against adjusted bars. Orders are sized at prior
Close; the next Open is used only to value fills, then the following Open to realize the holding interval. This
does not prove raw broker quantity rounding, opening auction liquidity, locates, or realized slippage. Use fixed
$100k capital with $150k nominal gross sizing (momentum $100k before volatility scaling). Check actual pre- and
post-trade Open marks and subsequent Close marked gross against $180k; a gap can cause a breach and then the backtest fails, not retroactively resizes
the fill. Report one-way turnover (traded notional divided by twice fixed capital). Charge half of each round-trip
5, 10 and 20 bp assumption on each trade, a 0.21 bp sell-side fee, and 1.5% annual actual/365 borrow on
prior-Close marked short notional, including weekend and holiday nights. Do not assume interest on cash or short proceeds.

## Selection, gates and reporting

Process Train and Validation before opening any Holdout prices to the research engine. Rank each family by Train
10 bp Sharpe (stable ID tie-break), and freeze the first candidate satisfying all development vetoes: strictly
positive net, sector exclusions, and plateau in both Train and Validation at both 10 and 20 bp. If none passes, freeze
the top Train-ranked member as a non-promotable diagnostic. Build and freeze only the one specified ensemble and
its automatic probes. No choice can change after the receipt. The full grid, plus ensemble and its parameter
probes, count in DSR; do not count transaction-cost reruns as additional trials at the same cost or treat LOSO
data stress as a candidate. For each cost, estimate the expected maximum daily Sharpe under the zero-skill null
from the cross-trial sample dispersion of Train daily Sharpes, counting unusable constant or invalid trials as
zero. Use that fixed reference for [Bailey and López de Prado DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
in all periods. DSR is reported, not an additional pass threshold.

A candidate qualifies only with all development vetoes and the following Holdout checks at **both 10 and 20 bp**:
strictly positive net; strictly positive net after removing the largest five winning days; one-sided centered
10,000-trial 5-session circular block-bootstrap p-value strictly below 0.05; all 11 single-sector removals strictly
positive; and a stable neighboring plateau. An unavailable result fails a gate. The sector stress removes the
sector's stocks and tradable sector ETF before replay (keeping SPY as required baseline/hedge); unaffected baskets
are re-ranked where appropriate. A neighbor varies one adjacent grid level; the sector-neutral and cross-sectional
book topologies are different, so only their within-topology depth changes are neighbors. A plateau requires at
least two neighbors and at least two-thirds of all registered neighbors positive with Sharpe at least half the
center's Sharpe, independently at each gated cost and split. Candidates do not inherit a probe's result.

Report all trial development split metrics and all frozen Holdout probe metrics relative to the same benchmarks;
report all 11 calendar years for each frozen representative. Report net, net excluding the best 5 and 10 winning
days, annualized daily Sharpe, maximum drawdown, arithmetic annualized return over maximum drawdown (Calmar),
OLS SPY beta and up/down-SPY net and sample counts. Bootstrap reported for frozen representatives and plateau probes
in each split and for representatives by calendar year. The full price tape is opened for scoring only after
reproducing the byte-identical development receipt and ledger committed to Git with the protocol and code hashes.
Do not promote, retune or reopen a failing Holdout.
