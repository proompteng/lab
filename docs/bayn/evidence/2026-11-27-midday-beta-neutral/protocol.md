# Wave 1A evaluation protocol

Freeze this grid before scoring the frozen cohort. The 66 dates are one shared evaluation cohort, not an independent
confirmation of the best row. No row may be added, dropped, or retuned based on its outcome.

- Warmup: 2026-07-16–2026-08-24. Evaluation: 2026-08-25–2026-11-25, all provider calendar sessions, in order.
  Isolate Midday without Morning/Noise, catalyst/borrow gating, portfolio competition, or account compounding; assume
  shorts are available. Use the production regular-session resolver, baseline builder and policy constants.
- Signal ladder: production relative VWAP; 14- and 20-session OLS beta residual; ATR14-normalized 20-session
  residual; whole-cross-section median demeaning of the normalized score; separate semi/non-semi median demeaning
  with same-group pairing; whole-cross-section median with dispersion gate and scaling at 40/60/80 bp. Fit OLS with
  intercept to matched prior regular-session open-to-close returns, minimum 14 matches, clamped to [0.5, 3].
  Use the production trailing-ATR recipe (14 sessions, minimum five, 200-bar regular-day summaries); no undocumented
  daily snapshot substitute. The normalization divides by ATR in bp; the result is dimensionless, not a fitted
  Gaussian z-score. The dispersion measure is the IQR of raw beta residuals. After the gate, multiply gross
  allocation by min(1, current IQR / (2 × median of prior same-checkpoint IQRs)), requiring 10 of 14 prior sessions.
  This is a Nagel-inspired proxy for state-dependent liquidity provision, not Nagel's empirical specification.
- Scan completed bars timestamped 11:30–12:00 ET (inclusive); the next minute is the first eligible execution proxy.
  Use the first eligible basket per day. Use signed extremal ranks, up to two pairs, and the v2 single-leg fallback
  for independent execution. No intentional single leg in protected mode. For semi neutrality use the six named
  constituents WDC, MU, COHR, LITE, AMD, NVDA as one group and the rest as the other.
- Execute the entire signal ladder at fixed 10 bp / independent / equal-dollar and at spread-adjusted 1.5× / flatten /
  beta-dollar. Compare the baseline at all five fixed collars (10, 15, 20, 25, 35 bp), spread-adjusted center
  max(15 bp, 1.5 × completed-minute median spread), and ATR center 0.15 × ATR14. Compare those five fixed collars
  and spread/ATR families at 1/1.5/2× and 0.10/0.15/0.20× in each of two beta-z / beta-dollar protection modes:
  flatten orphan or widen only the missing leg by 10 bp for one minute, then flatten the orphan if it still fails.
  Also compare beta-z with equal-dollar sizing at the spread-center collar for both protection modes. Deduplicate
  exact grid overlaps. Redistribute each pair's 36% gross budget for equal estimated dollar-beta, then floor whole
  shares at the signal-time limit.
- Fixed 2/5/10 bp round-trip scenarios apply half the cost adversely to each next-minute open, inside any limit.
  The IEX scenario uses the first recorded bid/ask in the relevant execution minute, stressed by an additional
  1 bp per side as an explicit adverse-selection allowance. It requires a completed-minute quote for placement;
  the adaptive spread collar also requires that quote in fixed-cost scenarios. No lookahead into the execution
  minute to decide which orders to place. Starts at the next-minute bucket, not purported exact quote timestamps.
  Fill proxy requires clearing the order limit; missing entry evidence is no supported fill. Quote size, queue and
  original receipt timing are unavailable. No assumed cost-free or atomic paired fills.
- Unpaired filled legs remain exposed until the next supported executable flatten price after expiry/rescue.
  Use v2 stop/target distances and absolute flatten clock (five minutes before early close), with causal
  next-bucket executable pricing for stop/target and timed exits. No intrabar touch as a fill. Use the verifier's
  modeled 0.21 bp sell-side fee and $100,000 fixed capital. Missing liquidation evidence makes the session
  unresolved, not zero P&L. Report post-work residual dollars and estimated beta dollars, orphan risk before and
  after remediation, and sell fees and execution cost separately.
- Report every row under all four cost regimes: full-period net, daily annualized Sharpe, net without the five
  largest daily outcomes, folds of 22 dates, and the worst of 18 complete reruns excluding one equity each.
  Apply the 10,000-draw one-sided null-centered circular 5-session block bootstrap and report the Deflated Sharpe
  Ratio across complete scored configuration × cost trials, using their full count as the independent-trial
  assumption (conservative for correlated variants). Keep unresolved and undefined results explicit.
- Promotion requires a beta-adjusted, beta-sized protected row, all 66 dates resolved, at least 75% four-leg
  completion across all 66 dates in every cost regime, no retained orphan exposure, and positive net,
  ex-top-five net, all three folds, and worst LOSO at 5 bp, 10 bp and IEX. Also require a bootstrap p-value ≤ 0.05,
  DSR ≥ 0.95, better ex-top-five net and no worse post-work estimated-beta drift than the reference in those
  three regimes. A plateau requires both adjacent parameter values within the same collar family or gate family
  to pass the same gates, including retaining at least 80% of the center's ex-top-five net at 5 bp, 10 bp and IEX.
  An absent neighbor is insufficient evidence. No v3 production helper unless a candidate qualifies.
