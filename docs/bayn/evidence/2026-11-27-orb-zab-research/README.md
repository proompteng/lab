# Bayn Wave 1B: opening-range relative volume and noise-area exits

This is retrospective event-time research, not an execution qualification or a policy change. The active
`bayn.intraday-alpha-policy.v2`, its 18-equity sleeve, and migrations 0222/0223 are unchanged. The pure
RVOL, chase-cap, and trailing-exit functions have no production caller.

## Frozen protocol

- **Calendar:** train 2024-01-02 through 2025-06-30; validation 2025-07-01 through 2026-03-31; holdout
  2026-04-01 through 2026-11-25. The seven-symbol panel uses the three-year bars through September 11,
  then the live export beginning with September 14 (the next exchange session). Adjust pre-split NVDA
  price fields by 1/10 and its volume by 10. The separate August 25–November 25 live panel uses the live
  export only, including July 16–August 24 warmup, and reports three consecutive 22-session folds.
  The recent 66 sessions overlap holdout and were used in earlier research; they are not independent confirmation.
- **What “frozen” means:** select one candidate per sleeve on Train. Validation can reject that selection,
  never replace it. Commit the generated development receipt before producing this run's holdout report.
  The failed predecessor already scored 138 configurations on this same date window. Its branch and
  trial ledger were not published, so this is a chronological, previously inspected holdout, not an
  untouched or prospective out-of-sample cohort. Count those 138 trials conservatively as additional tests.
- **ORB:** hold the original 10:50 ET last entry time, opening direction, SPY and own VWAP confirmation,
  first breakout attempt, bracket, and risk budget fixed. Cross OR5/15/30 with no filter and the three
  RVOL thresholds. Compare chase-distance ranking vs RVOL at a decision, plus a top-three RVOL shortlist
  frozen before the first eligible breakout. RVOL uses exactly the previous 14 regular sessions with
  complete same-horizon ranges; it is unavailable, not zero, if any are incomplete. For the no-RVOL
  proxy, a range may have up to 10% missing bars but must have minute 0 and its closing minute.
  Test the 0.25× daily ATR chase cap, adjacent collars, 1R breakeven, VWAP, both combined, and the
  legacy hard exit versus 60 minutes from fill and EOD. Earlier horizons start after their own range.
- **Noise:** compare the v2 31/91/151/211/271/331 elapsed-minute clock and its bracket with scheduled
  15/30/60-minute completed checkpoints, band 0.8/1/1.2, collar 10/15/20/25 bp and QQQ/SMH versus wider
  and single-ETF sleeves. Exit ablations cover VWAP alone, the opposite band, the breakout-side band,
  VWAP combined with the breakout-side band, and a ratcheting ATR stop. At a paper-style checkpoint,
  the combined long exit reference is max(VWAP, upper band), and short is min(VWAP, lower band).
  The true opposite-band rule is a separate trial. Bayn's initial protective backstop and one attempt
  per symbol remain; this is a test of the paper's exit mechanic, not a replication of the full paper.
- **Economics:** fixed $100,000 reference equity and whole shares, no compounding. Bar-close limit;
  next-minute open if inside, otherwise a same-minute touch at the adjusted collar, with no later entry
  chasing. Split 2/5/10 bp round-trip NBBO **assumptions** equally between sides and charge 0.21 bp on
  sell notional; IEX spread observations are diagnostic only. Active prior stops handle gaps at the
  worse open, and ambiguous both-touch bars are stop-first. A resting entry may stop on an adverse
  fill-minute print but cannot take a fill-minute target or ratchet. Checkpoint/VWAP and timer exits
  use the first printed open at/after their activation, never the signal close. EOD means close minus
  two minutes (five for Midday); last printed opens must be inside the regular session.
- **Gates:** select by highest 10 bp Train complete-case Sharpe among upgrades with ≥30 closed legs and
  ≥90% complete sessions, with a deterministic diagnostic fallback if no trial has support. Train and
  Validation whole-window 10 bp net must be positive; Validation must beat the proxy, close ≥20 legs,
  survive removal of the best five days and show a plateau (≥75% positive among at least two adjacent
  settings that differ in one listed parameter). Frozen Holdout also must be positive at all three costs,
  beat the reference at 10 bp, close ≥20 legs, pass the same plateau/top-five check, remain positive
  in every LOSO rerun, yield block-bootstrap p < 0.05 and DSR ≥0.95, and have positive 10 bp live-window net.
  No model gate turns retrospective evidence into live capital authority.

The ORB definition is motivated by [Zarattini, Barbon & Aziz](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284).
The Noise exit distinguishes the breakout-side band used in
[Zarattini, Aziz & Barbon](https://concretumgroup.com/wp-content/uploads/2026/02/Beat-the-Market.pdf)
from a cross through the opposite side of the whole band. Neither paper establishes Bayn's results.

## Measurement and limits

One committed attempt uses one quota even if unfilled. An observed no-trade or collar miss contributes zero
under the model, but a missing required SPY mark, missing committed next-minute entry bar or unresolved exit
makes that daily total unknown. Archived sparse IEX bars can exclude individual candidates and miss stop touches;
held gaps and coverage are retained. Do not read reported closed-leg subtotals or complete-case metrics as complete
returns. No mark, volume, or price is forward-filled. The regression tests check decision-time ordering and next-bar exits.
This is a bar-price scenario, not an original-arrival or NBBO reconstruction. It omits latency, book queue, size and
partial fills, borrow eligibility and charges, financing, operating cost, buying-power contention and broker stop-limit
execution. In particular, the v2 proxies are independent sleeves, not substitutes for the audited concurrent v2 replay.

Annualized Sharpe uses 252 sessions with an arithmetic daily mean and sample standard deviation. Max drawdown uses
cumulative daily net against fixed starting equity; Calmar divides annualized net / equity by drawdown / equity.
Break-even bp is (pre-execution gross minus sell fees) per entry dollar, conditional on that scenario's closed trade path;
it is not a root of the re-executed cost curve. Ex-top-five removes the five largest daily net values in the window.
LOSO reruns selection, weighting and fills without one traded symbol at a time; SPY remains a benchmark when removed
from the traded universe, and a single-symbol trial's LOSO is cash. The one-sided p-value uses 999 seeded, circular
five-session moving-block draws of the mean-centered calendar series. It is not evaluated across missing dates.
[Deflated Sharpe](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) uses the unannualized
10 bp Train Sharpe dispersion across all nondegenerate enrolled trials plus the larger multiplicity count for
the previous unseen ledger (one test per configuration, not a separate winner at each cost), and each outcome's
daily sample length, skew and non-excess kurtosis. Assuming all configurations independent for the expected-maximum
threshold is conservative relative to counting just estimated independent trials; the statistic does not establish
independence of returns or repair prior holdout access.

The daily correlation compares the two frozen diagnostics and the existing Midday selector on the same costs and
paired, jointly complete dates. The multi-year Midday universe is the three available single-name equities; the
live universe is the 18 production equities. Legs fill independently; no aggregate concurrent or disjoint-capital
portfolio is being proposed.

## Reproduce

Download the manifest and its four requested frozen inputs from the `bayn-research-datasets/2026-11-27/`
artifact prefix into one private directory, or pass `--s3` in an artifact-enabled runner. Both modes verify
the pinned manifest and compressed/uncompressed SHA-256 and length before using the data. Do not commit the data.

```sh
tool=services/bayn/tools/research-orb-zab-multiyear.ts
dir=docs/bayn/evidence/2026-11-27-orb-zab-research
bun "$tool" --freeze --s3 /tmp/wave1b-new-freeze.json
bun "$tool" --report --s3 "$dir/freeze.json" /tmp/wave1b-new-results.json
```

The report first recomputes and validates the development receipt, including relevant code SHA-256s, without
scoring any later session. The two commands exclusively create their output files.
