# Wave 10D preregistration: orthogonal ETF Pillar 3

## Sample and access order

The required primary panel is the two Wave 5C frozen daily SIP `adjustment=all` archives (27 ETFs plus DIA and UUP).
The object prefixes, bytes' SHA-256 fingerprints and ETF roster are pinned by the inherited reader
and included in the receipt. Neither source includes TIP. Do not replace TIP with another ETF, a synthetic proxy,
or an unadjusted series. The study cannot freeze or open Holdout without an explicitly authorized immutable TIP
supplement from Alpaca SIP `adjustment=all` for the same dates, with its manifest SHA-256 pinned independently.
This is an input requirement, not authorization to acquire or use another source. Train is 2016-01-04–2021-12-31 (1,511 sessions), Validation is
2022-01-03–2023-12-29 (501), and Holdout is 2024-01-02–2026-11-25 (729). Preserve the complete
2,741-session calendar, warm-up, and positions at fold boundaries. No missing bars are backfilled.
The full-range compressed daily envelopes must be fetched and authenticated in development, but
the reader checks dates before decoding prices; only dates through 2023-12-29 can enter development
arrays, signals, or selection. Do not open the separately stored B0 Holdout tape in development.

Commit this protocol and the generated development receipt before decoding Holdout prices. Score must
first reproduce Train and Validation exactly and compare the emitted JSON with the committed receipt;
the receipt binds protocol, scorer/replay source hashes, input identities and decoded development.
Verification uses committed content, not the original branch, freeze commit SHA, or Git ancestry.
Record the first freeze publication separately from the deterministic score output. This is a
fresh study-level selection lock, not a claim that the dates or assets were unseen by earlier studies.

## Registered grid: 34 trials, no replacements

Use 21- or 42-session reviews aligned to the first archive session (one global clock per cadence).
Use completed adjusted closes through the review date only; orders execute at the following open.
At review, compare target against actual prior-close marked weights: execute only when the larger
of aggregate buy or sell weight changes is at least 10 percentage points. Initialize in SHY at the
first open, charging entry costs. Marks on held positions must exist; no forced final liquidation.

- **A, 16 trials:** Cross 63/126-session log relative return and 21/42 cadence with four sets of
  curve proxies: slope (TLT/SHY and TLT/IEF), breakeven (TIP/IEF), credit (HYG/LQD), and all four
  pairs. Each pair votes for its rising leg (or denominator if the ratio falls); exact ties abstain.
  Sum votes per ticker, divide by its 20-session daily log-return volatility (floor 0.25%/day),
  then normalize to 80%; the remaining 20% is SHY. If there are no votes, hold SHY.
- **B, 4 trials:** Cross long-only and long/short with 21/42 cadence. For each of GLD, SLV, DBC, USO
  and UUP, average the 63/126/252-session log returns divided by their horizon square roots and
  floored 20-session daily log-return volatility (same floor as A); apply tanh. Long-only clips
  negative scores to zero; long/short keeps their signs. Multiply by inverse-20d-vol normalized
  across all five names. Unused risky gross goes to SHY. Short proceeds are not reinvested.
- **C, 12 trials:** Cross 63/126-session momentum and 21-session reversal with 2L/2S or 3L/3S
  and 21/42 cadence. Rank by signed log return divided by its trailing daily log-return volatility
  and square root of horizon (use A's floor). Universe: XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU,
  XLB, XLRE, XLC. Require a contiguous signal window and contemporaneous 126-session SPY beta
  (OLS on daily log returns) before ranking. Go long the highest ranks, short the lowest (ties
  by ticker). Allocate 50% each side, plus 100% SHY collateral. Within each side blend equal
  weights toward its low- or high-beta member until both sides hit the same beta, the midpoint
  of their overlapping beta ranges. If no interior overlap exists, park in SHY (identical constant
  betas on both sides need no adjustment). Dollar and estimated SPY beta neutrality apply at
  target, not between fills. Report realized SPY beta separately.
- **D, 2 trials:** Independently choose one representative of each of A, B, C using the rule
  below. Form A+B and A+B+C with fixed capital weights proportional to the inverse standard
  deviation of each component's daily SHY-excess returns across Train+Validation at 10 bp, 1%
  borrow. This equalizes ex-ante standalone excess-return risk contributions before correlations;
  it is not a covariance risk-budget optimizer.

Development selection: first prefer candidates with positive compounded SHY excess and
under 6× annual one-way turnover in both development folds, at 10 bp and 1% borrow. Within
that tier (or within the failing tier if none pass), maximize the lower fold SHY-excess Sharpe.
Break exact ties by registration order. Only A/B/C representatives and the two D ensembles
are eligible for promotion; score all other rows for transparency, never reselect.

## Execution, portfolio comparators and inference

Price trades at their next open; track signed fractional shares and cash, compound daily NAV, and
deduct 2/5/10 bp **one-way** on all traded dollars plus 0.21 bp on sales. Daily stock-loan fees
are 1% annual on short notional using ACT/365; also report 0.5% on all short-capable sleeves and
both ensembles as cost sensitivity, not additional strategy selections. Apply the current
session's charge to the open book and non-session elapsed days to the prior book. Assume no
borrow-rebate or financing credit; marks and borrow availability are not executable quotes.
Annual turnover is half absolute traded dollars divided by contemporaneous NAV, annualized at 252.
No resizing between strategy reviews apart from the modeled sleeve-level capital resets below.

Reproduce the [Wave 5C F4](../2026-11-27-10yr-vol-regime-carry/README.md) SHY-idle replay
(`F4-42-1-LQD-parity`) and the [Wave 9B Wave 6A B0 control](../2026-11-27-10yr-qqq-smh-conditioning/README.md)
(`B0/30/1.4/opposite_band/inverse_vol_parity`, zero cash return). Verify overlapping
published costs per fold before comparison. Reprice both at twice this study's one-way bp in
their round-trip cost interfaces; B0 keeps its published sizing (including at the extrapolated
20 bp RT). Divide B0 daily fixed-$100k P&L by $100k to get the sleeve return. Blends use a modeled
daily capital reset at prior close (apply the same one-way friction on aggregate absolute
sleeve transfers; no additional sell fee on sleeve transfers). This is an allocation diagnostic,
not simulated joint orders; no cross-sleeve netting, buying-power or market-impact credit.
Report F4 + Pillar 3 and equal-weight F4+B0 + Pillar 3 with 25% and 50% to Pillar 3, each against
its own paired baseline. Include standalone B0 and F4 comparators. Report Pearson correlation
with both controls for all days and SPY underwater days (SPY adjusted close below its running
high-water mark), separately for full and Holdout.

For each cost, estimate the expected maximum daily null Sharpe from all 34 development
SHY-excess daily Sharpes and 34 trials, using the existing
[Deflated Sharpe Ratio](https://doi.org/10.3905/jpm.2014.40.5.094) implementation. If a trial
has constant excess in development use its zero Sharpe in this cross-trial fit; constant
Holdout excess cannot pass inference. Score the frozen benchmark against Holdout daily
SHY-excess (non-normal adjusted). This controls only the registered grid, not earlier research.
Use the [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870), 10,000 draws,
circular geometric blocks averaging 5 sessions and seed `0x27f22fed`. Compute one-sided
mean p against SHY from centered daily differences. Compare portfolio Sharpe on paired
resamples (same dates and blocks for both legs); use the one-sided basic-bootstrap 95% lower
bound on Sharpe lift and report the nominal centered p. Calmar and MaxDD lift are point
estimates. Ex-Top-10 removes the ten largest positive daily excess days from **both** paths
before comparing their compounded returns. Rebase account statistics within each window,
but do not reinitialize underlying strategies.

## Decision

At 1% borrow, a frozen finalist must satisfy **at every 2/5/10 bp cost**:

1. Holdout compounded SHY excess > 0 and Holdout Ex-Top-10 SHY excess > 0.
2. Holdout nominal stationary-bootstrap p < 0.05 and DSR >= 0.95.
3. Full and Holdout annual one-way turnover < 6× and absolute daily correlation < 0.25
   with both F4 and B0. SPY drawdown-day correlations are diagnostics.
4. At the **same** 25% or 50% allocation across costs, positive paired-bootstrap lower bound
   for Holdout Sharpe lift vs both F4 and F4+B0, and positive Holdout Calmar lift vs F4+B0.

No alternate gates based on the results. If none passes, use the requested DO NOT PROMOTE
disposition. Even a statistical pass would not grant broker, deployment, or capital authority.
