# Wave 5C registered protocol: Volatility-managed risk parity and cross-market carry

## Question and evidence boundary

Do fixed, long-only, unlevered volatility and cross-market relative-price rules generate **positive compounded return
in excess of buy-and-hold SHY** with **<4× annual one-way turnover** separately in Train, Bear Validation and
Holdout? These are spread/regime proxies, not separately observed yield-curve slopes, credit OAS, inflation or
dollar carry. “Convexity” here is conditional exposure to inflation and dollar havens, not measured option convexity.
SHY is a 1–3 year Treasury ETF, not literal T-bills or a guaranteed cash yield.

Wave 3C tested signed trend, calendar/rebalance signals, pullbacks and HYG-gated rotation. Wave 4D already tested
credit/inflation/dollar regimes, volatility-scaled trend and risk-budget ensembles. The new estimands here are
**inverse realized variance of a long-only equal-risk-contribution book**, the two **short/medium realized-vol
ratios**, and a **two-credit-ratio EMA vote coupled to a duration-aware defensive winner**, separately and together.
Do not claim the broad ideas of credit timing or portfolio volatility targeting are new. This is an unlevered,
daily-data adaptation of [Moreira–Muir](https://www.nber.org/papers/w22208), not their original monthly replication.
The two unscaled F1 controls isolate the scaling effect on the same risk budgets and review cadence.

The 2024–2026 ETF period was **already examined** in Waves 3C/4D and also informed Wave 4C.
Here “Holdout” means no Wave 5C scoring, selection or calibration on those sessions before the remote freeze;
it does not make the market tape independent or establish prospective skill. Catalog composition is fixed
retrospectively and not survivorship-free. Adjusted SIP prices do not establish point-in-time corporate action
vintages, executable spread, auction participation, capacity, market impact, broker financing, or trading authority.

## Immutable input

Use only the supplied two Alpaca consolidated SIP daily `adjustment=all` exports under the
`agents-artifacts/bayn-research-datasets/` prefix, and verify the manifest and compressed bytes against their
pinned SHA-256 (also verify the base's uncompressed SHA-256). Use the original eight-field TSV, with the 27
manifest ETFs only from base, plus DIA and UUP from the supplement. Align by New York session date on the
2,741-session base calendar; require each supplement bar on every date. No proxy or forward fill. XLC has no
observations before 2018-06-19. XLRE is missing 2016-01-25 and 2016-02-16. Keep both on the calendar; the risk-on
basket requires 20 consecutive closes ending at the signal date, so a pre-listing session cannot allocate to XLC.
No gaps in the required core or benchmark marks are allowed.

| Partition       | Inclusive interval       | Sessions |
| --------------- | ------------------------ | -------: |
| Train           | 2016-01-04 to 2021-12-31 |    1,511 |
| Bear Validation | 2022-01-03 to 2023-12-29 |      501 |
| Frozen Holdout  | 2024-01-02 to 2026-11-25 |      729 |

The development command hashes the source, protocol and archives and only decodes prices through 2023-12-29.
Push the development-only `freeze.json` to the assigned branch before invoking `--score`. Scoring requires the
exact freeze commit to be reachable from the remote branch tip and reproduces its receipt bytes, including
code/protocol hashes and Train+Validation economics, before decoding Holdout prices. All registered trials, costs
and omissions are then scored. No result-dependent fit, alternate tape, cadence, family substitution or result suppression.

## Common signal and trade rules

- Start timing after 100 completed sessions. Review the first target after the 100th close and every 21 or 42
  sessions thereafter. Use prices and holdings through that close to decide whether to trade. Require at least
  10 percentage points of portfolio replacement: max(sum of positive target weight deltas, absolute sum of
  negative deltas), equivalent to half of absolute changes including cash. If triggered, target the whole book
  at the next open; otherwise retain the exact shares. No same-close fills, stops, intra-session trades or leverage.
- Risk base: equity (SPY/QQQ/EFA/EEM), Treasury duration (IEF/TLT), gold (GLD), broad commodities (DBC) and USD
  (UUP). Give the five sleeves equal risk budgets, split within each sleeve. Use the full 60-session covariance
  of close log returns (population moments); shrink off-diagonals 20% and add a diagonal 2%-annual-volatility
  squared ridge. Solve positive equal risk contribution with 48 fixed cyclic coordinate passes. Normalize to
  sum to one. RV is annualized volatility of this **current** base-weight vector on trailing 5/20/60 returns,
  using unshrunk sample-window covariance (population divisor); no future returns or executed sleeve P&L.
- Scale weights with `min(1, (target / max(RV, 4%))^power)`. There is never more than 100% target gross.
  Unused target weight goes to idle. No parameter uses Train moments except the inferential reference and
  descriptive family-leader lock below.

### Grid: 62 configurations

| Family                             | Rules and axes                                                                                                                                                                                                    |   N |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --: |
| F1: volatility-managed risk parity | Power 1 (inverse vol) / 2 (inverse variance), RV20/RV60 and 8%/10% reference volatility, each with 21/42 review. Also two unscaled power-0 controls (one per review).                                             |  18 |
| F2: credit and defensive selector  | HYG/IEF or HYG/LQD as primary; the other as secondary. 50/100-session EMA, 5/10-session weight smoothing, 21/42 review.                                                                                           |  16 |
| F3: compression overlay            | Inverse-vol RV60/10% base, then reduce by 50%/75% for RV5>1.25×RV20 or RV20>1.25×RV60; test fast, slow or both (equal average of the two cut indicators). 21/42 review.                                           |  12 |
| F4: fixed macro ensemble           | Blend desired allocations, not P&Ls. F1 10%/RV20 with power 1/2; F2 100-session EMA and 10-session smoothing with IEF/LQD primary; F3 both ratios with 50% cut. Mix F1/F2/F3 at thirds or 50/25/25. 21/42 review. |  16 |

F2 trends are price or pair ratio divided by its EMA minus 1, using an initial full-window arithmetic seed
and standard `2/(N+1)` gain. The primary and secondary credit votes carry weights of 2 and 1 respectively:
offense is the fraction of available vote weight strictly above zero. Missing votes abstain; no votes means no offense.
When offense is positive, assign 80% of it to broad equities/sectors (SPY, QQQ, IWM, DIA, SMH, EFA, EEM, VNQ
and all 11 sectors), 10% to HYG/LQD and 10% to SLV/USO, equally within a sleeve on eligible members. If a sleeve
is empty its weight is idle.

The remaining `1 - offense` selects the highest **strictly positive** own-price EMA trend among SHY, IEF,
TLT, GLD, DBC and UUP, subject to:

- Duration vote: sum of EMA trend signs of TLT/IEF and TLT/SHY.
- Inflation vote: sum of EMA trend signs of DBC/TLT and GLD/TLT.
- Block TLT if duration <0 or inflation >0; block IEF when both duration <0 and inflation >0. Block DBC if
  inflation <0. Block UUP if its UUP/SHY trend is available and nonpositive. Missing pair trends abstain.
- Ties use the listed haven order. No positive eligible haven leaves the defensive fraction idle. Smooth every
  target weight (including zeroes) from the first valid global close at the specified EMA gain, starting at zero.

## Accounting

- Maintain two independent compounded fractional-share books starting with unit equity. In the zero-cash book,
  unallocated equity earns zero; explicit SHY can still trade. In the SHY-idle book, fund idle exposure by buying
  SHY at the first open and sweeping residual target weight at each triggered rebalance. Combine explicit and
  sweep SHY in one order. Gaps accrue to old shares before trades. For the modeled next-open fill, size post-fee
  weights on equity marked at the opening print; only the historical close decides whether and what to target.
  Simultaneous fractional target weights at the print are a replay assumption, not a conditioned auction ticket.
- Charge half of each round-trip rate (2/5/10/20 bp) per leg plus a 0.21 bp sell fee. The requested 1.5% annual
  short borrow has no application: none of these books permits a short leg. No terminal liquidation. Keep
  positions, smoothing and indicator history across folds. Report close-marked NAV since the prior window
  boundary, not a newly seeded account. First session is open-to-close; later returns include overnight moves.
- Turnover is 252 × average of (buys + sells) / (2 × pre-fee opening NAV); include SHY sweep, exclude drift.
  Frictionless passive SHY and SPY receive first open-to-close and subsequent close-to-close adjusted returns.

## Metrics and decision

- On Train, Validation, Holdout, the full sample and **every calendar year** (2026 through November 25), return
  both books' compounded net, actual excess in percentage points (strategy return minus passive SHY return),
  Ex-Top-5/10 net and excess (drop the largest positive portfolio days from both paired paths), annualized net
  and paired daily excess Sharpe, maximum close-to-close drawdown, Calmar, one-way turnover, SPY beta and
  compounded net/excess on down-SPY days. Undefined statistics are null. Annualization uses 252 sessions.
- On paired daily SHY-idle minus SHY simple returns, test mean excess >0 with a one-sided
  [stationary circular bootstrap](https://statistics.stanford.edu/technical-reports/stationary-bootstrap):
  10,000 resamples, geometric blocks with mean length 10, centered null, fixed xorshift32 seed 0x5c2016,
  plus-one correction. This is a conditional p-value, not corrected for selection or shared samples.
- [Cumulative DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) uses daily excess Sharpe with
  skew/kurtosis correction. Freeze the expected maximum under the zero-mean null using cross-trial dispersion
  of Wave 5C Train+Validation SHY-idle excess Sharpes at each cost, without an effective-N discount.
  Prior comparable trial paths do not share the same idle and fee contract; count, but do not pool their Sharpes.
  Count 24 Wave 2A ETF trials, 122 Wave 3C, five Wave 4C (P2–P5 plus S2; P2 reuses S1), 135 Wave 4D,
  11 Wave 4G (10 ETF plus ETF-bearing ensemble), 16 Wave 4I (four ETF plus 12 ETF-bearing blends), and
  the 62 current trials. Costs, omissions and paired benchmarks are not separate trial searches. The exact
  audited ETF penalty is **375** configurations, not a claim of a complete cross-program trial registry.
  Report a sensitivity using the mission's approximate **5,000** prior cross-wave trials plus 62 current
  trials. Neither DSR version corrects for serial dependence or converts reused data into an independent sample.
- Re-run all 29 leave-one-ETF-out (LOEO) omissions for every configuration/cost on all three folds.
  Remove the ticker from portfolio targets and inputs, recompute available risk budgets, votes, rankings,
  band decisions and fees. SHY/SPY remain external comparators when omitted; no SHY sweep when SHY is omitted.
  Report both books' net and turnover and the SHY-idle excess. An unused-asset null omission is not independent evidence.
- Structural pass requires SHY-idle net excess >0 and turnover strictly <4× in all three folds at a given cost.
  A robust pass also requires positive paired Ex-Top-5 and Ex-Top-10 excess in each fold. Plateau % is the
  fraction of registered same-family configurations differing by one field that robustly pass. Unscaled controls
  neighbor one another across cadence; they are not treated as one-field perturbations of a scaled rule.
- Qualification requires a robust pass, plateau ≥2/3, all 29 omissions positive over SHY and below 4× in all
  folds, and Holdout p <0.05 and cumulative DSR ≥0.95, **at all four costs**. A negative result is valid.
  The report locks one representative per family at 10 bp before Holdout: prefer Train/Validation structural
  passes, then maximize the lesser of their two annualized excess Sharpes, breaking ties by registry order.
  Report all trials regardless of representative status. No research result grants trading or rollout authority.
