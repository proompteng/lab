# Bayn Wave 4I: clean ten-year SP100 factors

## Data and time boundary

Use the frozen Alpaca SIP `adjustment=all` daily archive under
`agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. The manifest and archive are pinned by
SHA-256 in the CLI. The source has 450,712 rows and 2,741 SPY sessions. The manifest has 138 stocks and 27 ETFs;
exclude **MMC from every date**, leaving 137 equities in all 11 GICS sectors. The
[announced rename to MRSH](https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html)
took effect January 14, 2026. Do not splice a successor or infer a return. This is the manifest's retrospective,
survivor-selected sector map, not historical S&P 100 membership. Later starts (e.g. LIN and XLC) and isolated
gaps (e.g. XLRE) do not receive pre-inception proxies or backfilled bars. UUP is **not** in the 27-ETF manifest;
do not substitute or extend the archive. Do not infer currency exposure for the overlay.

| Split          | First Open | Final Open | Sessions |
| -------------- | ---------- | ---------- | -------: |
| Train          | 2016-01-04 | 2021-12-31 |    1,511 |
| Validation     | 2022-01-03 | 2023-12-29 |      501 |
| Frozen Holdout | 2024-01-02 | 2026-11-25 |      729 |

Price features can warm across splits, but actual holdings start flat and finish liquidated at each final Open.
End-of-split liquidation and risk exits are separate from scheduled rebalances. Initial warmup and idle dates
remain in the denominator, even for 2016. The Holdout is sealed against Wave 4I selection. It is not prospective or
independent of [Wave 3A](https://github.com/proompteng/lab/pull/16366), which analyzed the same dates and informed
these hypotheses. The aim is to measure **crash resistance**, not guarantee that these portfolios are crash-proof.

## Signals and candidate grid

On the first Open of each split with history and every 10th or 21st session of the absolute SPY calendar (according
to the candidate), determine target shares from the preceding Close. Retain incumbent names within the top/bottom
`K + ceil(K/2)` rank band, then fill open slots at the best ranks. Tie-break by ticker. Long-only stock budgets
are 75% of sleeve capital; spread books target 50% per leg unless specified below. Unused slots remain uninvested.

1. **52-week high proximity** ([George and Hwang](https://doi.org/10.1111/j.1540-6261.2004.00695.x)).
   Rank adjusted Close divided by the maximum daily adjusted High over 252 observed sessions through the decision
   Close. Test K = 10/15/20, every 21 sessions: unhedged long-only, regime-hedged long-only, dollar-neutral, and
   sector-neutral. When either SPY or HYG is below its 200-day SMA at the decision Close, the regime hedge shorts
   half the book's estimated SPY beta notional, capped at 37.5% of the sleeve. Otherwise it stays unhedged.
2. **Quality trend** (inspired by [Ang, Hodrick, Xing, and Zhang](https://doi.org/10.1111/j.1540-6261.2006.00836.x)).
   Rank cross-sectional `z(high proximity) - z(idio vol)`. Idio vol is sample residual volatility from 60 daily
   log returns regressed with intercept on SPY and the stock's manifest sector ETF. Require all 60 paired returns.
   Test the same K and 21-session cycle: unhedged long-only, long-only with a static-on-rebalance SPY short to cancel
   positive book beta (cap 75% of sleeve), and sector-neutral. Quality short eligibility at the rebalance Close
   requires above-or-equal median eligible idio vol and Close below SMA100. For both families' sector-neutral
   books, assign K slots proportionally to eligible sector breadth, capped by the number of disjoint pairs;
   reassign remaining slots to the sectors with the largest unfilled proportional allocation. Select shorts first,
   then disjoint longs; each pair has equal long and short notional at the decision Close. Dollar-neutral and
   within-sector neutrality describe targets, not prices at the next Open or exposures between rebalances.
3. **Crash-managed momentum and trend-filtered BAB** ([Barroso and Santa-Clara](https://doi.org/10.1016/j.jfineco.2014.11.010),
   [Daniel and Moskowitz](https://doi.org/10.1016/j.jfineco.2015.12.002),
   [Frazzini and Pedersen](https://doi.org/10.1016/j.jfineco.2013.10.005)). Compare 12-minus-1-month momentum
   (Close at decision minus 21 sessions divided by Close at decision minus 252 sessions) and low-beta versus
   high-beta BAB (rank raw 126-session SPY log-return beta, size each leg using beta shrunk one-third toward one and
   floored at 0.2). Rank the K shorts before applying the trend test: no new stock short unless its decision Close
   is strictly below SMA50 or SMA100; no replacement for rejected slots. Cover an existing managed short at the
   next Open when it ceases to meet that test, even out of cycle. BAB scales both legs by the short slot fill
   fraction and matches their estimated beta dollars at formation. The momentum long leg remains when short
   gates leave cash. Scale both legs by `min(1.25, targetVol / annualized126dUnscaledFactorVol)`; use only
   completed Open-to-Open returns of an otherwise identical unscaled shadow book running from the start of the
   tape, without friction, borrow or carry. Use multiplier one before 126 post-entry observations or with zero vol.
   Multiply by another 0.5 when decision-close SPY is >15% below its 252-session close high and its 20-session
   annualized vol exceeds 25%. This is a causal panic proxy, not a fitted reproduction of the cited models.
   Test 10/21 sessions, K = 10/15/20, SMA50/100, target volatility 8%/12%, for both signals.
4. **Equity plus ETF trend**. Start from the highest Train 10 bp SHY-excess Sharpe equity finalist among those
   with no development veto below; if none passes, choose the top Train-ranked equity diagnostic. Combine that
   exact equity candidate with each of four ETF trend baselines (126/252-session adjusted Close momentum,
   10/21-session schedules), at ETF allocations 25%/50%/75%. Long ETF slots enter above zero trend and retain
   incumbents above −2%; take no ETF shorts except an equity sleeve's SPY hedge. ETF slots have fixed equal
   budgets across seven groups and equal weights within each group: US (SPY, QQQ, IWM, SMH); sector (ten GICS
   ETFs other than XLRE); Treasuries (TLT, IEF, SHY); credit (HYG, LQD); commodity (GLD, SLV, USO, DBC);
   international (EFA, EEM); real estate (VNQ, XLRE). Leave unfilled slots in cash, without redistributing.
   Keep independent sleeve targets and net shared tickers before applying costs and financing.

The grid includes 12 high-proximity, 9 quality, 48 managed, 4 standalone ETF and 12 combined trials (**85 total**).
Four cost reruns and three cash/benchmark views of one candidate are not separate strategy trials.

## Execution, costs and cash

Simulate fixed $100,000 funding and fractional adjusted shares. Only the prior Close sizes orders; next historical
Open values fills. P&L is marked from Open to Open, attributed to the session at which it is booked. Rounding,
auction liquidity, borrow locates and realized slippage are not verified. Charge half of the 2/5/10/20 bp
round-trip rate on absolute order notional, plus 0.21 bp on sells (including short sales) and 1.5% ACT/365 on
prior-Open post-trade short notional. Weekends and holidays accrue borrow. No reinvestment of strategy profits
in sizing. No separate long financing or return on restricted short proceeds. Only
`max(0, 100000 - marked gross exposure)` at the preceding Open earns SHY Open-to-Open total return.
Report zero idle carry, SHY idle carry, and SHY-carry net minus P&L from a fully funded buy-and-hold SHY
position over the same boundary. The SHY benchmark compounds via the adjusted Open price ratio; it incurs no
commission. Calendar buckets rebase their benchmark at their first underlying interval, potentially the final
Open of the prior year; only split boundaries reset holdings.

The [RTX event was announced March 30, 2020](https://raytheon.mediaroom.com/2020-03-30-Raytheon-and-United-Technologies-Obtain-All-Regulatory-Approvals-to-Close-Merger-of-Equals).
Exit at the March 31 Open, prohibit entries through April 3, and restart all RTX lookbacks from April 6. Other
missing next Opens or adjusted Close-to-next-Open ratios outside [0.5, 2] cancel that ticker's orders/hold,
record a last-observed-Close accounting liquidation (including modeled liquidation fees for an existing
position), and reset its feature warmup. No future prices or synthetic opening prints; the fallback is **not**
an executable fill or evidence of actual corporate-action proceeds. It vetoes promotion without aborting the
unrelated positions or split. Required SPY/SHY pricing and invalid source rows fail closed.

## Selection, tests and publication

Rank per distinct stock factor/book and separate ETF/combined slots by Train 10 bp SHY-excess Sharpe; ID breaks
ties. Pick the first without development vetoes, or the top Train diagnostic when all fail. Vetoes are nonpositive
net, ex-top-5 or ex-top-10 net; annualized one-way turnover at least 6×; last-bar fallback or unfilled order;
inadequate plateau; or nonpositive 2022 or 2023 net. Require these in both development splits, at both 10 and 20
bp, for both zero cash and SHY excess where applicable. Costs of 2 and 5 bp and SHY-carry total P&L are reported,
not selection gates. A plateau requires at least two neighbors and two-thirds of all registered neighbors with
positive net, positive ex-top-5 net, no fallback, turnover <6× and positive Sharpe at least half the center's.
A neighbor differs in exactly one setting in the same factor and topology. All three K values are peers
(`K` alone differs); combined ETF allocation neighbors are adjacent quarter weights. Preselect one center per
slot and publish its full neighbor list. Holdout cannot change the center, parameters, overlay exposure, or probes.

On all three splits, a reported research pass additionally requires every one of 11 sector LOO replays
(re-rank after removing the sector stocks and its tradable ETF, with no reassignment of the dropped ETF budget)
to show positive net and no missing execution at both stress costs/views. Require one-sided
[stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870) p < 0.05/11 across the 11 finalist slots:
center daily P&L to the mean-zero null, circular geometric blocks of mean length 5, 10,000 draws with a fixed
seed, and the plus-one tail correction. Require [Deflated Sharpe Ratio](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
≥ 0.95 in both stress views/costs, with a no-skill expected maximum calibrated from the 85 wave-local Train daily
Sharpes per cost and view (undefined Sharpes entered as zero). Count all 360 Wave 3A trials in the extreme-value
trial count (445 cumulative); the comparable prior-trial distribution for all costs/cash bases is unavailable,
so no prior Sharpes are imputed. Bootstrap models serial dependence in the mean; classical DSR uses the usual
sample count, skew and kurtosis and does not make this overlapping, survivor-selected study independent.
No live/paper promotion is authorized by any result; a passing result still requires fresh prospectively
registered data before an investment decision.

Report split and all 11 year metrics for frozen centers: USD net, net after removing the five/ten largest
positive days, annualized sample daily Sharpe (252 sessions), percent/USD peak-to-trough drawdown, arithmetic
annualized return over fractional max drawdown (Calmar), OLS SPY beta, down-SPY net, and annualized one-way
turnover (traded dollars divided by twice $100k). Report stationary p and cumulative DSR for centers by split
and year, descriptive P&L/turnover and vetoes for each LOO case, and probe/plateau counts by split, cost and
gated cash view. The combined center reports standalone equity/ETF performance and exact Pearson correlation
of aligned daily net, by split and year, cost and view. Yearly 2026 ends November 25.

Push this protocol and its exact executable sources before `--freeze`. Freeze reads only Train and Validation
prices, computes development results and publishes the source/dataset hashes, trial ledger digest, benchmarks,
and selections in `freeze.json`. Commit and push that receipt on the registered branch before `--score`.
Scoring verifies the remote receipt, reproduces it byte-for-byte without Holdout prices, claims a one-shot
result marker, and only then parses the Holdout observations into the engine. Publish the result together
with the complete development ledger; do not reopen a completed or interrupted score to retune.
