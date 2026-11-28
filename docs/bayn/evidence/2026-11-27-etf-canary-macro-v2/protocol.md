# Wave 4D registration: total-return ETF allocations versus SHY

This is a read-only structural mechanism comparison, not an unseen-data discovery or a deployment
decision. Wave 3C already inspected the 2024–2026 market tape, and motivates the mechanisms and
turnover target. No wave-4D parameters or thresholds may change after Holdout scoring. Register
the complete grid, use all candidates in every report irrespective of the development outcome, and
publish this protocol, the exact code and the Train/Validation receipt before reading Holdout prices.
Never redirect the scoring CLI to an uncommitted or unpushed receipt.

## Inputs and folds

- Primary source: immutable Alpaca consolidated SIP `adjustment=all` daily OHLCV/VWAP in
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. The runner verifies the
  Wave 3C manifest, gzip and decoded TSV SHA-256 identities.
- The advertised ticker list and retained object disagree: the frozen manifest and TSV contain
  SMH and VNQ, not DIA and UUP. The requested universe is
  SPY, QQQ, IWM, DIA, XLK, XLF, XLE, XLV, XLI, XLP, XLU, XLY, XLB, XLC, XLRE, TLT, IEF, SHY, HYG,
  LQD, GLD, SLV, DBC, USO, UUP, EFA, EEM. A supplemental frozen SIP total-return export explicitly
  approved for DIA and UUP is required, with its source and SHA-256 recorded in the development
  receipt. No proxy, use of SMH/VNQ as stand-ins, or test without the dollar driver is permitted.
- 2,741 sessions: Train 2016-01-04 to 2021-12-31 (1,511); Bear Validation 2022-01-03 to
  2023-12-29 (501); Holdout 2024-01-02 to 2026-11-25 (729). Carry positions and signal history
  across folds; metrics independently rebase each reporting interval. 2026 is partial.
- XLC has no bars before 2018-06-19. XLRE has no bars on 2016-01-25 and 2016-02-16. A lookback
  requires its own contiguous history. No backfill, future listing information, partial-window ranking, or
  terminal liquidation. Missing required bars fail validation; pre-warmup allocations fall back to idle.

## Trial grid: 135, fixed before development

1. **Canary (96):** DAA/BAA/VAA-inspired adaptation, not canonical replication. Panel A:
   EEM/HYG/IEF/TLT; panel B: EEM/LQD/IEF. Composite = 12/4/2/1 times prior-close 21/63/126/252
   simple returns. For binary protection, any nonpositive (or invalid) signal moves all weight to
   defense. Breadth protection allocates `b/B` to defense, where `b` is weak count and `B` is
   available panel size. Rebalance every 10 or 21 sessions, first after 252 returns. Allocate
   offense among the top 2/3/4 by the same composite (equal or inverse 63-session vol), and
   defense equally among the top 1/2 strictly positive options. Offense: SPY, QQQ, IWM, EFA,
   EEM, GLD, DBC, XLK, XLE, XLF, XLV. Defense: SHY, IEF, TLT, GLD, UUP, DBC.
2. **Continuous TSMOM (16):** Five sleeves: equities (SPY/QQQ/EFA/EEM), rates (TLT/IEF),
   credit (HYG/LQD), commodity/metals (GLD/SLV/DBC), and FX (UUP). For each ETF, equal blend of
   21/63/126/252 log returns normalized by trailing 63-session annualized volatility multiplied
   by square root of horizon/252; clip the blend to ±1. Normalize within equal-budget sleeves
   by available asset count and inverse vol; floor signal and sizing volatility at 4%. Use
   63-session covariance of close log returns to scale the full book to 8% or 10% annualized
   volatility, subject to gross 100%. Long-only clips negative signals to zero; signed allows
   shorts. Trade each ETF if its prior-close drift reaches 5 or 10 percentage points or on
   every 5th or 10th session, starting after 252 returns.
3. **Credit/inflation/dollar regime (6) and defensive sector comparison (8):** Test 63/126
   session log relative HYG/IEF for credit, and the mean of available GLD/TLT and DBC/IEF log
   relative returns for inflation. Strictly positive denotes the upper state; no valid credit or
   inflation means cash. Growth/disinflation = QQQ/SPY/XLK/IEF; reflation = XLE/DBC/GLD/XLI/SPY;
   stagflation = UUP/GLD/DBC/SHY; deflationary crash = TLT/IEF/GLD/SHY. Equal weight valid names
   except positive UUP gets twice the weight in stagflation (nonpositive UUP is excluded), and
   positive UUP leaves 25% idle in either credit-positive state. Five-day EMA (alpha 1/3) of
   target allocations starts at cash. Review daily, every 21 or every 42 sessions; trade ETF
   drift ≥10 points at review. The <4×/yr threshold is a test, not a presumption.
   The sector comparison ranks the 11 sector ETFs by strictly positive return above SHY
   divided by 63-session volatility (4% floor). Use all sectors only if SPY absolute and
   HYG/IEF relative trends are positive; otherwise restrict to XLV/XLP/XLU. Test 63/126 session
   signals, top 2/3 equal weight and 21/42-session cadence. No shorting or substitution.
4. **Ensemble (9):** Use fixed membership and equal ex-ante risk-contribution budgets, not
   members selected from development scores: panel A breadth / 21 / 3 / 2 / inverse vol;
   long 8% TSMOM; 63-session macro EMA. Blend their desired allocations, not cash-weighted
   historical P&Ls or already executed sub-portfolios. Estimate their covariance with the same
   trailing 63-session ETF matrix, shrink off-diagonals by 25%, and add 2%-volatility-squared to
   each diagonal. Fixed 32-pass cyclic positive risk-budget solver. Empty sleeves leave their
   third idle. Review every 21 sessions with a 5-point band, starting after 252 returns.
   One-at-a-time neighbors: cadence 10/42, bands 2.5/10 points, canary top 2/4, trend target
   10%, macro lookback 126. No recursive mixing or refitting.

## Execution and costs

Use prior-close signals and **realized** prior-close position weights for drift decisions.
Old holdings first earn the overnight move; trades size at the next adjusted SIP daily open
to target post-fee weights; new holdings earn only post-open moves. For a partially rebalanced
book, unchanged shares remain; if needed, pro-rate changed ETF target notionals to the
remaining gross budget. Market moves may drift existing risk above the target gross cap.
Fractional shares, model fills at daily open, no leverage funding. Short collateral and an
equal amount of equity earmarked against the short earn zero; charge 1.5%/365 per elapsed
calendar day on prior-close short notional. This is not a borrow availability test.

Sweep remaining unencumbered equity to SHY on the first open and at portfolio rebalances.
Net SHY orders across explicit and sweep holdings. In the independent zero-cash scenario,
explicit defensive SHY still trades; only idle balances earn zero. Pay half of **2, 5, 10 or
20 bp round trip** on each leg plus **0.21 bp** on sells (including short opens). The 2 bp scenario
is an NBBO-scale modeled hurdle, not a measurement of NBBO, market impact or executable size:
frozen daily SIP bars contain no quotes. Turnover is 252 × mean per-session
(buys + sells) / (2 × pre-fee opening NAV), including the sweep, excluding position drift.

## Metrics and decision

- Every trial and cost reports both compounded net returns (SHY sweep and zero-yield idle),
  frictionless SHY buy-and-hold, and excess in percentage points (strategy wealth minus SHY
  wealth, not their ratio). SHY is a 1–3 year Treasury ETF, not a literal T-bill fund or the
  overnight rate. First session uses open-to-close for strategy and benchmarks; later
  sessions include overnight on actual holdings.
- Every split, full sample and 11 calendar years: net, excess, Ex-Top-5/10 net and excess
  (remove up to 5/10 highest positive strategy-return dates on both legs), annualized Sharpe
  of net and of the paired daily strategy-minus-SHY return, max drawdown, Calmar, annualized
  turnover, SPY beta and net/excess compounded on down-SPY days.
- Bootstrap the centered paired daily excess series with a one-sided 10,000-draw stationary
  circular block bootstrap, expected geometric block length 10, fixed seed, and plus-one
  correction. Test mean excess >0, not a hypothetical independent re-run of Wave 3C.
- Cumulative DSR uses the skew/kurtosis-adjusted daily excess Sharpe, with the expected
  maximum across **122 Wave 3C + 135 Wave 4D = 257** trials at each cost. The daily Sharpe
  dispersion comes from the frozen 135 Wave 4D Train+Validation paths: the old zero-idle
  test's Sharpes are not comparable, so only its trial count enters. Treat trials as
  independent for the multiplicity hurdle, not as independent evidence. DSR is not a serial
  dependence correction or proof of a fresh holdout.
- LOEO reruns signals and accounting without each of the 27 symbols; re-rank, reweight and
  recompute gates (do not subtract the omitted asset's P&L). Dropping SHY removes explicit
  allocations and the sweep, but external SHY remains the comparator. Dropping SPY removes it
  from traded baskets and signals, but not as the external beta comparator. In the sector
  screen, missing SHY means use zero as the ranking hurdle. Report all three split returns
  with both cash treatments, SHY excess and turnover. Unused symbols are informative null checks.
- Plateau counts registered same-family neighbors differing by one adjacent numeric or
  alternative categorical parameter (ensemble variants neighbor the base). A neighbor passes
  if all three folds show positive net excess, positive excess after top 5 and 10, and
  turnover <6×/yr (<4×/yr for macro). No tuning from the neighborhood after scoring.
- Separately flag the structural pass (positive net excess and turnover under its ceiling in
  all three splits). Qualification requires the stricter split criteria, Holdout p <0.05 and cumulative DSR ≥0.95,
  at least two-thirds of registered neighbors passing, and positive excess in every LOEO fold,
  at every cost. Without HYG or IEF, the standalone macro rule is cash-only and cannot pass the
  stricter omission gate; that dependence does not erase its unablated structural comparison.
  A negative result is reportable. No research outcome is trading authority.

Mechanism references: [Keller–Keuning DAA](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3212862),
[Keller BAA](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4166845),
[Baltas–Kosowski](https://www.cmegroup.com/content/dam/cmegroup/education/files/demystifiing-time-series-momentum-strategies.pdf),
[Bailey–López de Prado DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf),
[iShares SHY prospectus](https://www.blackrock.com/us/individual/literature/summary-prospectus/sp-ishares-1-3-year-treasury-bond-etf-2-28.pdf).
