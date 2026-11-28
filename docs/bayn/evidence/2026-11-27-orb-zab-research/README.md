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

The commands below use the runner and results from the [archived checkout][study-revision].

Download the manifest and its four requested frozen inputs from the `bayn-research-datasets/2026-11-27/`
artifact prefix into one private directory, or pass `--s3` in an artifact-enabled runner. Both modes verify
the pinned manifest and compressed/uncompressed SHA-256 and length before using the data. Do not commit the data.

```sh
tool=services/bayn/tools/research-orb-zab-multiyear.ts
dir=docs/bayn/evidence/2026-11-27-orb-zab-research
bun "$tool" --freeze --s3 /tmp/wave1b-new-freeze.json
bun "$tool" --report --s3 "$dir/freeze.json" /tmp/wave1b-new-results.json
bunx oxfmt /tmp/wave1b-new-results.json
cmp "$dir/results.json" /tmp/wave1b-new-results.json
```

The report first recomputes and validates the development receipt, including relevant code SHA-256s, without
scoring any later session. The two commands exclusively create their output files.

## Decision: no v3 promotion

The [original development freeze](https://github.com/proompteng/lab/commit/028118b64f5911e33c731d54c910a68e19465acf)
was pushed before Holdout scoring. Review moved I/O into the Effect runtime and corrected the VWAP-only
exit to work even when a historical band is unavailable. The regenerated [receipt](freeze.json)
rebinds the source hashes; dates, trial parameters, selection and qualification rules did not change.
Neither sleeve had an upgrade
eligible for selection under the Train coverage/support rule, so the receipt records diagnostic fallbacks, not
winners. The diagnostic ORB had 249/374 complete Train sessions and Noise had 253/374. Holdout covered 166 sessions;
**no trial with a complete Holdout had positive net at 10 bp** (93/93 ORB and 37/62 Noise had complete Holdout
results). The other 25 Noise trials have unknown whole-window returns, not zero returns. Among the 66-session results,
36 ORB and 29 Noise trials with complete results were positive at 10 bp, but **none** remained positive excluding
the best five days. Do not wire either helper into v2 or promote a configuration on these cohorts.

| Sleeve / configuration                             | Holdout 2 / 5 / 10 bp net (USD) | Live 66 2 / 5 / 10 bp net (USD) |
| -------------------------------------------------- | ------------------------------: | ------------------------------: |
| ORB v2 proxy                                       |          +250 / −1,383 / −4,285 |              +995 / +467 / −606 |
| OR15, 1.5× RVOL, cap, breakeven, 60m (frozen)      |        −2,445 / −3,018 / −3,961 |        −3,885 / −4,024 / −4,184 |
| OR5, 1.5× RVOL, rank by RVOL                       |        −2,265 / −2,868 / −3,978 |        +2,731 / +2,506 / +2,186 |
| OR30, 1.5× RVOL, rank by RVOL                      |              −8 / −467 / −1,171 |            −741 / −870 / −1,077 |
| Noise v2 proxy                                     |                         Unknown |        +3,731 / +3,253 / +2,468 |
| Noise 30m, 1×, 15 bp, VWAP/band, all ETFs (frozen) |            +895 / −573 / −3,067 |        +2,763 / +2,194 / +1,310 |
| Noise 30m, 1×, 15 bp, VWAP/band, QQQ/SMH           |          +1,800 / +512 / −1,965 |        +3,713 / +3,217 / +2,363 |

The 10 bp holdout ORB fallback had Sharpe −2.66, $4,618 drawdown, Calmar −1.30, −7.98 bp break-even,
−$5,902 ex-top-five, block p=0.976 and DSR <0.001. The Noise fallback had Sharpe −1.52, $5,647 drawdown, Calmar
−0.82, 3.71 bp break-even, −$7,058 ex-top-five, p=0.897 and DSR 0.0024. Both failed the frozen-neighbor and
LOSO gates. Positive recent noise results reverse after the five best days are removed (−$2,607 at 10 bp).

**ORB:** at OR5 and 1.5× RVOL, volume ranking rather than chase improved the 10 bp live result by $989 but
worsened Holdout by $263. The no-RVOL OR5 proxy also made +$1,604 in the live sample and lost −$5,492 in Holdout.
The OR5 advantage over OR30 is therefore cohort-dependent here, and neither the cost collar nor dynamic exit
grid turns it into stable positive holdout economics. Today's named universe and historical IEX volume are not
comparable to the paper's broad historical stock screen.

**Noise:** the [exact #16342 cost-cohort decomposition](../2026-11-26-alpha-cost-cohorts/README.md#supported-common-entry-subtotals)
shows that the same 48 entries fell from +$521.00 at 2 bp to +$162.13 at 5 bp and −$435.98 at 10 bp, with
identical quantities and exit clocks/reasons. The four extra 2 bp fills contributed −$567.18, making the 2 bp
subtotal negative despite positive common-entry P&L. The 2→10 bp change of −$389.80 was −$956.98 on
common entries offset by +$567.18 from lost fills. The November 17 co-held QQQ mark gap and first-week partial
warmup make the original whole-window net unavailable. No claim about the missing path follows from the subtotals.

Over the longer panel the independent static Noise proxy produced +$17,459 pre-cost gross on 583 supported
closed trades at 2 bp; +$14,151 remained. At 10 bp, execution cost alone was $14,625 on the 568 remaining
trades and supported net was just +$1,589 (682/729 complete sessions; the complete-case net excluding the
five best days was −$7,445). Shorts accounted for $11,925 of the supported 2 bp net; 579 of 583 legs were
timed closes. At 10 bp, Validation's supported closed subtotal was −$1,158 and Holdout's +$2,271; these
are not complete returns. On the broader Wave 1B live export the independent v2 proxy is positive even at
10 bp, but it trades a different set of entries than the original concurrent replay. Differences in input/benchmark
coverage, opportunity priority and fill/exit proxies prevent a like-for-like comparison. The retained evidence
supports a narrow gross edge eaten by costs, changes in fill membership and return concentration—not a
verified market-regime explanation or a previously robust three-year edge.

### Pairwise sleeve correlation at 10 bp

These are correlations of each isolated sleeve's daily net for dates complete in **all three** paths, not correlations
of deployed strategy returns. See the [ledger][archived-results] for the full matrices at each cost and in each split.

| Window             | Paired sessions | ORB–Noise | ORB–Midday | Noise–Midday |
| ------------------ | --------------: | --------: | ---------: | -----------: |
| Multi-year (all)   |         536/729 |    −0.033 |     +0.024 |       −0.128 |
| Multi-year Holdout |         166/166 |    +0.139 |     +0.041 |       −0.199 |
| Live 66            |           55/66 |    +0.356 |     +0.147 |       +0.260 |

### Observed IEX spreads, not a transaction-cost input

Median of per-minute IEX median spreads on the live window: COHR **136.80 bp**, LITE **153.88 bp**, MRVL
**143.94 bp**, WDC **90.50 bp**, versus SMH **4.35 bp**, QQQ **0.72 bp**, and SPY **0.52 bp**. These are
single-venue quote statistics, not consolidated NBBO fills. The economic paths all use the stated 2/5/10 bp
assumptions and never read these quotes to trade.

### Full trial ledger

[results.json][archived-results] retains every variant, three primary costs, all six half-years, all live thirds,
full and complete-case metrics, refit-free full LOSO reruns, coverage, matched cost attribution and correlations.
Read a trial's `costs["10"].windows[i]` using the top-level `metricColumns` in order and the panel's `windows[i]`
for its dates. LOSO uses the same window order and `losoColumns`; `null` means unavailable or undefined,
not zero. The compact index below uses 10 bp; \* denotes a supported closed-leg subtotal in an incomplete window,
rather than total net.

<details>
<summary>All 155 ORB and Noise trial IDs and 10 bp P&L (USD)</summary>

| Trial                                |     Train | Validation |  Holdout |  Live 66 |
| ------------------------------------ | --------: | ---------: | -------: | -------: |
| `orb-v2-proxy`                       | -10,471\* |   -7,300\* |   -4,285 |     -606 |
| `orb-or5-no-rvol`                    | -15,261\* |   -3,748\* |   -5,492 |   +1,604 |
| `orb-or5-rank-only`                  | -11,881\* |     -3,726 |   -4,862 |   +1,082 |
| `orb-or5-rvol1.2-chase`              |  -2,927\* |   -2,837\* |   -1,403 |     +539 |
| `orb-or5-rvol1.2-rank`               |  -3,220\* |   -2,165\* |   -2,510 |   +1,921 |
| `orb-or5-rvol1.2-cap-v2`             |  -3,220\* |   -2,508\* |   -3,106 |   +1,921 |
| `orb-or5-rvol1.2-cap-eod`            | -11,289\* |      -96\* |   -2,252 |   +3,406 |
| `orb-or5-rvol1.2-cap-60m`            |  -3,223\* |   -2,508\* |   -3,204 |   +1,921 |
| `orb-or5-rvol1.5-chase`              |  -5,321\* |   -2,261\* |   -3,715 |   +1,198 |
| `orb-or5-rvol1.5-rank`               |  -5,337\* |   -1,757\* |   -3,978 |   +2,186 |
| `orb-or5-rvol1.5-cap-v2`             |  -4,686\* |   -2,101\* |   -4,575 |   +2,186 |
| `orb-or5-rvol1.5-cap-eod`            |  -7,105\* |     +383\* |   -4,224 |   +3,828 |
| `orb-or5-rvol1.5-cap-60m`            |  -4,544\* |   -2,101\* |   -4,673 |   +2,186 |
| `orb-or5-rvol2-chase`                |  -1,535\* |   -3,344\* |   -3,295 |     +588 |
| `orb-or5-rvol2-rank`                 |  -1,468\* |   -3,344\* |   -3,179 |     +588 |
| `orb-or5-rvol2-cap-v2`               |  -1,051\* |   -3,344\* |   -3,776 |     +588 |
| `orb-or5-rvol2-cap-eod`              |  -3,397\* |   -3,772\* |   -5,371 |   +1,107 |
| `orb-or5-rvol2-cap-60m`              |  -1,111\* |   -3,344\* |   -3,874 |     +588 |
| `orb-or5-center-breakeven-v2`        |  -5,802\* |   -2,462\* |   -4,308 |   +2,087 |
| `orb-or5-center-breakeven-eod`       |  -7,959\* |     -909\* |   -3,446 |   +3,713 |
| `orb-or5-center-breakeven-60m`       |  -5,660\* |   -2,462\* |   -4,405 |   +2,087 |
| `orb-or5-center-vwap-v2`             |  -7,356\* |   -3,657\* |   -3,623 |   +2,804 |
| `orb-or5-center-vwap-eod`            |  -7,687\* |   -4,394\* |   -3,409 |   +2,968 |
| `orb-or5-center-vwap-60m`            |  -7,415\* |   -3,657\* |   -3,623 |   +2,804 |
| `orb-or5-center-breakeven-vwap-v2`   |  -7,941\* |   -3,813\* |   -3,439 |   +2,635 |
| `orb-or5-center-breakeven-vwap-eod`  |  -7,998\* |   -4,396\* |   -3,226 |   +2,908 |
| `orb-or5-center-breakeven-vwap-60m`  |  -8,000\* |   -3,813\* |   -3,439 |   +2,635 |
| `orb-or5-center-collar20`            |  -4,127\* |   -1,945\* |   -4,538 |   +2,154 |
| `orb-or5-center-collar20-vwap-eod`   |  -7,443\* |   -3,903\* |   -3,335 |   +2,904 |
| `orb-or5-center-collar30`            |  -4,127\* |   -1,945\* |   -4,538 |   +2,406 |
| `orb-or5-center-collar30-vwap-eod`   |  -7,443\* |   -3,903\* |   -3,335 |   +2,655 |
| `orb-or5-top3-rvol1.5`               |  -7,607\* |   -3,168\* |   -3,213 |   +2,064 |
| `orb-or15-no-rvol`                   |  -8,143\* |   -9,177\* |   -3,677 |   -2,419 |
| `orb-or15-rank-only`                 | -10,178\* |     -8,742 |   -1,606 | -2,537\* |
| `orb-or15-rvol1.2-chase`             |  -7,238\* |   -5,878\* |   -4,187 |   -3,334 |
| `orb-or15-rvol1.2-rank`              |  -7,432\* |   -5,396\* |   -4,100 |   -3,297 |
| `orb-or15-rvol1.2-cap-v2`            |  -7,432\* |   -5,739\* |   -4,100 |   -3,297 |
| `orb-or15-rvol1.2-cap-eod`           |  -4,199\* |   -6,595\* |   -4,450 |   -4,037 |
| `orb-or15-rvol1.2-cap-60m`           |  -7,563\* |   -5,735\* |   -4,136 |   -3,314 |
| `orb-or15-rvol1.5-chase`             |  -3,811\* |   -5,277\* |   -4,176 |   -4,542 |
| `orb-or15-rvol1.5-rank`              |  -4,247\* |   -4,812\* |   -4,270 |   -4,542 |
| `orb-or15-rvol1.5-cap-v2`            |  -4,247\* |   -5,155\* |   -4,270 |   -4,542 |
| `orb-or15-rvol1.5-cap-eod`           |  -3,750\* |   -3,315\* |   -2,955 |   -3,848 |
| `orb-or15-rvol1.5-cap-60m`           |  -4,345\* |   -5,073\* |   -4,228 |   -4,542 |
| `orb-or15-rvol2-chase`               |  -1,685\* |   -4,733\* |   -2,279 |   -2,676 |
| `orb-or15-rvol2-rank`                |  -1,774\* |   -4,268\* |   -2,414 |   -2,676 |
| `orb-or15-rvol2-cap-v2`              |  -1,774\* |   -4,268\* |   -2,414 |   -2,676 |
| `orb-or15-rvol2-cap-eod`             |    -545\* |   -4,920\* |   -2,625 |   -2,473 |
| `orb-or15-rvol2-cap-60m`             |  -1,883\* |   -4,283\* |   -2,414 |   -2,676 |
| `orb-or15-center-breakeven-v2`       |  -4,330\* |   -5,080\* |   -4,002 |   -4,184 |
| `orb-or15-center-breakeven-eod`      |  -5,113\* |   -3,268\* |   -2,956 |   -3,392 |
| `orb-or15-center-breakeven-60m`      |  -4,428\* |   -4,997\* |   -3,961 |   -4,184 |
| `orb-or15-center-vwap-v2`            |  -4,040\* |   -3,509\* |   -3,470 |   -3,257 |
| `orb-or15-center-vwap-eod`           |  -4,531\* |   -3,628\* |   -3,663 |   -3,397 |
| `orb-or15-center-vwap-60m`           |  -4,345\* |   -3,509\* |   -3,428 |   -3,257 |
| `orb-or15-center-breakeven-vwap-v2`  |  -4,183\* |   -3,434\* |   -3,286 |   -3,267 |
| `orb-or15-center-breakeven-vwap-eod` |  -4,917\* |   -3,611\* |   -3,383 |   -3,177 |
| `orb-or15-center-breakeven-vwap-60m` |  -4,488\* |   -3,434\* |   -3,244 |   -3,267 |
| `orb-or15-center-collar20`           |  -4,520\* |   -5,172\* |   -4,270 |   -4,676 |
| `orb-or15-center-collar20-vwap-eod`  |  -4,711\* |   -3,645\* |   -3,663 |   -3,697 |
| `orb-or15-center-collar30`           |  -4,520\* |   -5,172\* |   -4,270 |   -4,676 |
| `orb-or15-center-collar30-vwap-eod`  |  -4,711\* |   -3,645\* |   -3,663 |   -3,697 |
| `orb-or15-top3-rvol1.5`              |  -4,062\* |   -3,509\* |   -3,516 |   -3,399 |
| `orb-or30-rank-only`                 | -10,022\* |     -4,293 |   -4,914 |   -1,660 |
| `orb-or30-rvol1.2-chase`             |  -4,761\* |   -2,218\* |   -1,879 |   -1,543 |
| `orb-or30-rvol1.2-rank`              |  -4,581\* |   -1,910\* |   -1,593 |   -2,056 |
| `orb-or30-rvol1.2-cap-v2`            |  -4,581\* |   -1,910\* |   -1,593 |   -2,056 |
| `orb-or30-rvol1.2-cap-eod`           |  -4,204\* |   -2,980\* |     -682 |   -3,678 |
| `orb-or30-rvol1.2-cap-60m`           |  -5,178\* |   -1,706\* |   -1,541 |   -1,865 |
| `orb-or30-rvol1.5-chase`             |  -4,336\* |   -2,517\* |   -1,258 |     -565 |
| `orb-or30-rvol1.5-rank`              |  -4,156\* |   -2,517\* |   -1,171 |   -1,077 |
| `orb-or30-rvol1.5-cap-v2`            |  -4,156\* |   -2,517\* |   -1,171 |   -1,077 |
| `orb-or30-rvol1.5-cap-eod`           |  -1,829\* |   -4,160\* |     -687 |   -1,213 |
| `orb-or30-rvol1.5-cap-60m`           |  -4,449\* |   -2,427\* |     -946 |     -912 |
| `orb-or30-rvol2-chase`               |  -3,110\* |   -2,209\* |   -2,065 |     +288 |
| `orb-or30-rvol2-rank`                |  -3,241\* |   -2,209\* |   -2,065 |     +288 |
| `orb-or30-rvol2-cap-v2`              |  -3,241\* |   -2,209\* |   -2,065 |     +288 |
| `orb-or30-rvol2-cap-eod`             |  -1,485\* |   -2,889\* |   -1,994 |     +510 |
| `orb-or30-rvol2-cap-60m`             |  -3,479\* |   -2,221\* |   -1,746 |     +642 |
| `orb-or30-center-breakeven-v2`       |  -3,658\* |   -2,517\* |   -1,171 |   -1,077 |
| `orb-or30-center-breakeven-eod`      |  -2,367\* |   -4,247\* |     -938 |   -1,817 |
| `orb-or30-center-breakeven-60m`      |  -3,951\* |   -2,427\* |     -946 |     -912 |
| `orb-or30-center-vwap-v2`            |  -3,224\* |   -2,000\* |   -1,056 |     -857 |
| `orb-or30-center-vwap-eod`           |  -3,755\* |   -2,982\* |     -432 |     -816 |
| `orb-or30-center-vwap-60m`           |  -3,427\* |   -2,113\* |     -831 |     -692 |
| `orb-or30-center-breakeven-vwap-v2`  |  -2,825\* |   -2,000\* |   -1,056 |     -857 |
| `orb-or30-center-breakeven-vwap-eod` |  -3,039\* |   -3,089\* |     -947 |   -1,206 |
| `orb-or30-center-breakeven-vwap-60m` |  -3,028\* |   -2,113\* |     -831 |     -692 |
| `orb-or30-center-collar20`           |  -4,708\* |   -2,517\* |   -1,130 |   -1,082 |
| `orb-or30-center-collar20-vwap-eod`  |  -4,166\* |   -2,982\* |     -609 |     -821 |
| `orb-or30-center-collar30`           |  -4,708\* |   -2,517\* |   -1,130 |   -1,082 |
| `orb-or30-center-collar30-vwap-eod`  |  -4,166\* |   -2,982\* |     -609 |     -821 |
| `orb-or30-top3-rvol1.5`              |  -3,427\* |   -1,944\* |     -839 |     -914 |
| `noise-v2-proxy`                     |    +476\* |   -1,158\* | +2,271\* |   +2,468 |
| `noise-v2-collar15`                  |    -100\* |     -882\* | +2,623\* |   +2,469 |
| `noise-v2-collar20`                  |    +305\* |     -886\* | +2,685\* |   +2,465 |
| `noise-v2-collar25`                  |    +296\* |     -886\* | +2,680\* |   +2,465 |
| `noise-v2-vwap`                      |     -35\* |   -3,871\* |   -647\* |   +2,042 |
| `noise-v2-opposite-band`             |    +879\* |   -1,376\* | +2,458\* |   +2,468 |
| `noise-v2-breakout-band`             |    -196\* |   -2,753\* |   -662\* |   +2,607 |
| `noise-v2-vwap-boundary`             |    -539\* |   -3,155\* |    +11\* |   +2,728 |
| `noise-v2-trailing-atr`              |    -158\* |   -1,158\* | +2,222\* |   +2,292 |
| `noise-grid15-static`                |  +3,821\* |   -1,466\* |   -4,031 |     -608 |
| `noise-grid15-vwap`                  |  -3,165\* |   -4,693\* |   -7,188 |     -158 |
| `noise-grid15-opposite-band`         |  +4,459\* |   -1,324\* |   -3,692 |     -672 |
| `noise-grid15-trailing-atr`          |  +3,913\* |   -1,454\* |   -4,006 |     -684 |
| `noise-grid15-band0.8-collar10`      |  -9,607\* |   -5,183\* |   -8,527 |   -1,844 |
| `noise-grid15-band0.8-collar15`      |  -9,115\* |   -4,954\* |   -8,968 |   -2,028 |
| `noise-grid15-band0.8-collar20`      |  -8,673\* |   -4,683\* |   -8,116 |   -2,039 |
| `noise-grid15-band0.8-collar25`      |  -8,124\* |   -4,729\* |   -8,486 |   -2,407 |
| `noise-grid15-band1-collar10`        |  -5,134\* |   -3,947\* |   -5,103 |     -187 |
| `noise-grid15-band1-collar15`        |  -4,825\* |   -3,921\* |   -5,127 |      -65 |
| `noise-grid15-band1-collar20`        |  -4,144\* |   -3,769\* |   -4,599 |      -79 |
| `noise-grid15-band1-collar25`        |  -3,606\* |   -3,815\* |   -4,607 |      -87 |
| `noise-grid15-band1.2-collar10`      |  -5,331\* |   -4,624\* |   -4,841 |     -505 |
| `noise-grid15-band1.2-collar15`      |  -5,133\* |   -4,637\* |   -4,824 |     -366 |
| `noise-grid15-band1.2-collar20`      |  -4,381\* |   -4,610\* |   -4,255 |     -472 |
| `noise-grid15-band1.2-collar25`      |  -3,843\* |   -4,618\* |   -4,263 |     -480 |
| `noise-grid30-static`                |  +3,955\* |   -2,458\* |     -858 |     +745 |
| `noise-grid30-vwap`                  |  -1,752\* |   -5,085\* |   -4,120 |   +2,007 |
| `noise-grid30-opposite-band`         |  +4,745\* |   -2,641\* |     -447 |     +997 |
| `noise-grid30-trailing-atr`          |  +4,205\* |   -2,458\* |     -886 |     +569 |
| `noise-grid30-band0.8-collar10`      |  -6,038\* |   -7,860\* |   -3,993 |   +1,563 |
| `noise-grid30-band0.8-collar15`      |  -6,476\* |   -7,041\* |   -3,956 |   +1,815 |
| `noise-grid30-band0.8-collar20`      |  -7,294\* |   -6,702\* |   -3,563 |   +1,809 |
| `noise-grid30-band0.8-collar25`      |  -7,482\* |   -6,702\* |   -3,563 |   +1,809 |
| `noise-grid30-band1-collar10`        |  -2,580\* |   -4,561\* |   -1,722 |   +2,363 |
| `noise-grid30-band1-collar15`        |  -3,159\* |   -4,145\* |   -1,965 |   +2,363 |
| `noise-grid30-band1-collar20`        |  -4,342\* |   -3,802\* |   -1,684 |   +2,363 |
| `noise-grid30-band1-collar25`        |  -4,410\* |   -3,802\* |   -1,684 |   +2,363 |
| `noise-grid30-band1.2-collar10`      |    -676\* |   -3,903\* |   -1,012 |   +2,288 |
| `noise-grid30-band1.2-collar15`      |  -1,270\* |   -3,586\* |   -1,213 |   +2,360 |
| `noise-grid30-band1.2-collar20`      |  -2,072\* |   -3,534\* |   -1,222 |   +2,360 |
| `noise-grid30-band1.2-collar25`      |  -2,149\* |   -3,534\* |   -1,222 |   +2,360 |
| `noise-grid60-static`                |    -512\* |   -3,212\* |   -436\* |    -30\* |
| `noise-grid60-vwap`                  |  -3,127\* |   -5,234\* | -2,430\* |   +785\* |
| `noise-grid60-opposite-band`         |    -257\* |   -3,528\* |   -182\* |   +224\* |
| `noise-grid60-trailing-atr`          |    -403\* |   -3,212\* |   -450\* |   -203\* |
| `noise-grid60-band0.8-collar10`      |  -5,071\* |   -6,581\* | -3,034\* |   +983\* |
| `noise-grid60-band0.8-collar15`      |  -4,576\* |   -5,040\* | -3,478\* |   +954\* |
| `noise-grid60-band0.8-collar20`      |  -4,106\* |   -4,951\* | -3,362\* |   +947\* |
| `noise-grid60-band0.8-collar25`      |  -4,152\* |   -4,954\* | -3,362\* |   +947\* |
| `noise-grid60-band1-collar10`        |  -3,638\* |   -4,972\* | -1,192\* | +1,433\* |
| `noise-grid60-band1-collar15`        |  -3,480\* |   -3,432\* | -1,569\* | +1,466\* |
| `noise-grid60-band1-collar20`        |  -3,144\* |   -3,344\* | -1,264\* | +1,466\* |
| `noise-grid60-band1-collar25`        |  -3,180\* |   -3,347\* | -1,264\* | +1,466\* |
| `noise-grid60-band1.2-collar10`      |  -4,559\* |   -3,613\* | -1,797\* |   +773\* |
| `noise-grid60-band1.2-collar15`      |  -3,727\* |   -2,259\* | -2,373\* |   +789\* |
| `noise-grid60-band1.2-collar20`      |  -2,982\* |   -2,170\* | -2,375\* |   +789\* |
| `noise-grid60-band1.2-collar25`      |  -3,019\* |   -2,173\* | -2,375\* |   +789\* |
| `noise-all-etfs`                     |  -8,405\* |   -5,208\* |   -3,067 |   +1,310 |
| `noise-only-SMH`                     |    +467\* |   -1,406\* |   -3,029 |   +1,171 |
| `noise-only-QQQ`                     |  -3,340\* |   -3,375\* |     -510 |   +1,745 |
| `noise-only-IWM`                     | -12,199\* |   -2,596\* |   -2,492 |   +1,192 |
| `noise-only-SPY`                     |  -4,865\* |   -4,789\* |   -2,577 |     -157 |

</details>

[archived-results]: https://github.com/proompteng/lab/blob/4b25eaee338c3c4766360108733da2f266dff493/docs/bayn/evidence/2026-11-27-orb-zab-research/results.json
[study-revision]: https://github.com/proompteng/lab/tree/4b25eaee338c3c4766360108733da2f266dff493
