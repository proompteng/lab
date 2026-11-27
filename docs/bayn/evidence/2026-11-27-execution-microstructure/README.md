# Bayn execution microstructure — Wave 1E, 2026-11-27

**Research only; unqualified.** No runtime strategy, risk cap, migration, grant, or broker behavior changes. The
compiled `bayn.intraday-alpha-policy.v2` protocol hash remains
`5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d`, matching the
[reviewed PAPER activation](../2026-11-26-performance/paper-activation.md). Migrations 0222 and 0223 are unchanged.

## Evidence and method

[Machine-readable results](results.json) bind all four inputs to their frozen manifest, sizes, and SHA-256 receipts.
The study starts at the exchange's regular open and respects the frozen calendar's DST and early closes. Live tape
warmup is July 16–August 24, evaluation is August 25–November 25 (66 RTH sessions). The other tape is January 2,
2024–September 11, 2026; six tradable symbols (AAPL, AMZN, IWM, NVDA, QQQ, SMH) plus SPY as benchmark. It is
**not** spliced into live, so overlapping dates are not independent confirmation. Raw NVDA prices and VWAP before
June 10, 2024 are divided by ten and volumes multiplied by ten before constructing causal history
(39,532 regular-session rows). The historical tape represents 675 of 676 calendar sessions, with five
insufficient-baseline sessions and 428 missing benchmark checkpoints on the quota-aware decision path. These
limit the historical stop-risk denominator.

This is a **fixed-opportunity comparison**, not an integrated strategy backtest. The study uses the production
signal extractor, selector, funded exit plans, whole shares, and target planner. It assumes a flat $100k planning
book with $400k buying power for the entry/exit cohort, selects the first planned ORB and Midday candidate set per
day and first Noise leg per symbol. It applies those quotas before resolving each later phase, does not let
fills change cohort membership, and assumes short eligibility. A synthetic fresh quote on a completed bar lets
the production selector and funding contract run;
this does not reconstruct actual simultaneous IEX freshness. No concurrent occupancy, inference/ingestion
lag distribution, eligible size, queue, retries, or partial fills are inferred. For each collar stress, bracket
levels and shares stay sealed at v2's 10 bp sizing so the comparison changes **admission price tolerance**, not risk or selection. Adaptive collars use the production
trailing daily ATR14 ratio, computed from prior sessions only, expressed as a dollar amount at the signal close.
Missing ATR does not inherit a 10 bp collar. The historical funding checks before July 2026 use a retained schedule
for plan construction only; those dollars are gross, not made-up historical fees.

There are **two distinct feeds/models**:

- **Consolidated-cost proxy:** `close_t` and opens are frozen **IEX prints**, not SIP trades or NBBO midquotes.
  Stress 2/5/10 bp _round trip_ by applying half to each executable side and deduct dated fees separately.
  A buy must be at/below its ceiling, a short sale at/above its floor. We run both the requested adjacent open
  (`t+1`) and the first full open after v2's observation (`t+2`, with the observation at `t+1:02` and a
  60-second working window). The former can predate order submission. Neither is observed consolidated execution.
- **Observed IEX:** the first archived bid/ask in the minute is a separate one-venue limit diagnostic. One bucket
  establishes quote activity, **not** decision-time freshness or execution. Alpaca describes [IEX vs SIP](https://docs.alpaca.markets/us/v1.1/docs/market-data-faq)
  and [NBBO-based PAPER matching](https://docs.alpaca.markets/us/docs/paper-trading); that simulation does not
  validate live order-book depth, routing outcomes, or realized spreads.

Reproduce from the repository root with the five private objects under
`agents-artifacts/bayn-research-datasets/2026-11-27/` in a local directory:

```sh
bun services/bayn/tools/research-execution-microstructure.ts "$DATASET_DIR" /path/to/new-results.json
bunx oxfmt --write /path/to/new-results.json
cmp /path/to/new-results.json docs/bayn/evidence/2026-11-27-execution-microstructure/results.json
```

The CLI checks compressed/raw receipts and row boundaries before writing, refuses to overwrite evidence, and
does not require a broker connection. See the [model tests](../../../../services/bayn/tools/research-execution-microstructure.test.ts).

## 1. Entry collar and adverse selection

The unsigned checkpoint distributions in [results](results.json) cover all 20 symbols, including off-sleeve
names and absent pairs. The signed distributions below use only eligible candidates (Midday sign gate applied)
before daily quotas and ranking; a positive value means movement **with** the signal.

| Eligible signal | Adjacent prices present / missing |  Mean |    p01 |    p05 | Median |    p95 |    p99 |
| --------------- | --------------------------------: | ----: | -----: | -----: | -----: | -----: | -----: |
| Morning ORB     |                           586 / 4 | −0.22 | −28.27 | −13.12 |   0.00 | +10.64 | +22.59 |
| Midday          |                      22,670 / 482 | −0.23 | −19.68 |  −9.72 |   0.00 |  +8.86 | +18.31 |
| Noise Area      |                           194 / 3 | +0.27 | −13.32 |  −8.35 |  −0.10 |  +8.47 | +16.35 |

Drift is in bps. Across all 20 symbols and visited sleeve windows, the unsigned experiment has
48,115/18,745 observed/missing ORB pairs, 27,645/12,775 Midday pairs, and 4,308/1,932 Noise pairs.
Midday and Noise windows are not independent across symbols and minutes.

At **5 bp round-trip** cost, of 371 usable adjacent opens, the v2 collar missed 19, all with the signal.
It still accepted 160 positive drifts, 177 negative drifts, and 15 ties; “only fills against the signal”
is too strong. Drift averaged **−1.43 bp** for fills versus **+17.15 bp** for misses. At the first full
post-decision open, it missed 81 of 374 observations, all with the signal, and filled 92 positive,
197 negative, and four unchanged drifts. The means diverged to **−7.06 vs +20.41 bp**. Had all 81
misses filled at the stressed marks with the same bracket, their isolated closed net would have been
**+$5,867.92 (+36.57 bp)**. That is a counterfactual, not recoverable P&L.

| Entry collar    | Adjacent fills | Adjacent paired Δ vs 10 bp | Post-decision fills | Post-decision supported net / bp | Post-decision paired Δ vs 10 bp |
| --------------- | -------------: | -------------------------: | ------------------: | -------------------------------: | ------------------------------: |
| 2 bp            |            151 |                    −$9,785 |                 188 |                   $5,454 / 13.93 |                         −$2,260 |
| 5 bp            |            286 |                    −$6,378 |                 233 |                   $5,370 / 10.95 |                         −$2,344 |
| 10 bp           |            352 |                          — |                 293 |                   $7,715 / 12.42 |                               — |
| 15 bp           |            361 |                      −$415 |                 321 |                  $10,145 / 14.95 |                         +$2,431 |
| 20 bp           |            366 |                    −$1,178 |                 339 |                  $10,988 / 15.37 |                         +$3,273 |
| 25 bp           |            367 |                    −$1,126 |                 349 |                  $10,193 / 13.89 |                         +$2,478 |
| 35 bp           |            370 |                    −$1,493 |                 360 |                  $12,638 / 16.71 |                         +$4,923 |
| ATR14, 15–40 bp |            360 |                    −$1,466 |                 351 |                   $9,637 / 13.09 |                         +$1,957 |

There were 382 planned legs. Adjacent/post-decision price support is 371/374; ATR adds 10 unavailable legs
on each clock. Paired deltas compare only legs supported by both scenarios and round modeled fee cohorts
independently. Bps are per filled entry dollar, not percent of account equity. At 2/5/10 bp cost the
post-decision 35 bp paired delta was **+$4,717 / +$4,923 / +$4,552**, but the adjacent results were
**−$922 / −$1,493 / +$479**. Clock choice changes the sign. At 5 bp cost, post-decision ex-top-five
supported net was **−$214 at 10 bp** vs **+$4,785 at 35 bp**; supported 22-session folds were
$906/$2,696/$4,112 vs $941/$4,310/$7,387. Omitting each symbol from the fixed supported subset (not
reselecting) gives $5,127–$8,612 at 10 bp and $9,678–$13,695 at 35 bp. Most of the 5 bp stress
improvement comes from Midday. Results include descriptive block-bootstrap p-values, not a prospective
test or correction for searching collars. Whole-cohort net is **unknown**, not zero, where opens are
missing. All these P&L figures are closed-subset subtotals.

### Separate IEX quote diagnostic

| Symbol | RTH minute coverage | p50 / p95 of per-minute median spread (bp) | First next-minute quote within 10 bp / present / planned |
| ------ | ------------------: | -----------------------------------------: | -------------------------------------------------------: |
| AAPL   |     23,844 / 25,740 |                               2.69 / 14.91 |                                             28 / 33 / 35 |
| COHR   |     18,733 / 25,740 |                            136.80 / 461.47 |                                             10 / 23 / 32 |
| LITE   |     18,662 / 25,740 |                            153.88 / 468.17 |                                              8 / 23 / 30 |
| MRVL   |     18,760 / 25,740 |                            143.97 / 452.46 |                                              6 / 15 / 22 |
| WDC    |     19,229 / 25,740 |                             90.50 / 429.24 |                                              8 / 21 / 26 |
| QQQ    |     23,517 / 25,740 |                                0.72 / 5.19 |                                             34 / 34 / 34 |

Across all 20 symbols, 325/382 selected signal buckets and 326/382 next buckets contain a quote, and
225/326 first next quotes clear 10 bp. This is neither the 352-bar adjacent opportunity count nor a
model of actual consolidated spreads. The thin IEX semi quotes can be both wide **and** sparse; do not
widen a consolidated limit by the IEX spread or turn absent IEX quotes into NBBO marketability. The
current [entry compiler](../../../../services/bayn/src/jev/runtime.ts) anchors to completed bars and keeps
quote liveness and the two-sided stop/target checks distinct from the entry ceiling.

## 2. Activated stop-limit non-execution

Use the 10 bp **entry** and the full post-decision clock at 5 bp RT cost. Stop triggers and profit targets
remain fixed; the buffer changes only the executable stop limit. Stop activation is adverse-print based.
After activation test the stressed buy/sell price before booking an exit; a raw touch is not rounded into
a fill. On an intrabar stop, the adverse extreme is itself a trigger proxy if it clears; otherwise the
close is the ordered recovery proxy, not a potentially pre-trigger favorable high/low. A marketable
pre-existing target at the open precedes an intrabar stop; other both-touch bars use stop-first. A known
gap remains working until price recovers or the modeled timed exit. These are OHLC proxies, not proof
that a particular native child triggered or filled.

| Tape / offset              | Observed stop triggers | Blocked trades | Blocked minutes | Still working at timed deadline | Paired gross Δ vs 10 bp |
| -------------------------- | ---------------------: | -------------: | --------------: | ------------------------------: | ----------------------: |
| Live / 10 bp               |                     17 |     4 (23.53%) |               4 |                               0 |                       — |
| Live / 25 bp               |                     17 |      1 (5.88%) |               1 |                               0 |                −$115.65 |
| Live / 50 bp               |                     17 |              0 |               0 |                               0 |                −$139.77 |
| Live / 0.25 ATR14          |                     17 |              0 |               0 |                               0 |                −$139.77 |
| Seven symbols / 10 bp      |                    103 |      9 (8.74%) |              27 |                               3 |                       — |
| Seven symbols / 25 bp      |                    103 |      3 (2.91%) |               6 |                               1 |                −$107.28 |
| Seven symbols / 50 bp      |                    103 |              0 |               0 |                               0 |                −$162.78 |
| Seven symbols / 0.25 ATR14 |                    103 |              0 |               0 |                               0 |                −$162.78 |

There were 293 and 2,340 baseline filled legs, respectively. Eight live filled legs had no ATR for the
adaptive comparison. At 10 bp, the maximum blocked adverse mark was **28.59 bp / $98.36 beyond the
stop** (AMD, September 11; realized $34.17 beyond the stop) in live, and **65.06 bp / $224.76**
(NVDA, February 14, 2024; timed exit realized $149.26 beyond the stop) in the historical tape.
The historical 10 bp gaps split **6/62 train-dev, 2/32 validation, 1/9 frozen holdout triggers**.
The four live blocked minutes match the count in [#16342's retained replay](../2026-11-26-alpha-v2-replay/results.json);
different cohort and pricing rules prevent claiming the exact same four events. Wider offsets remove
observed gaps under this proxy but did **not** increase paired gross net: narrower orders sometimes
recovered at a better price. Zero observed gaps is not a guarantee of protection.

## 3. Timed protection release

| Sleeve           | Regular session | 13:00 early close | Who owns pre-deadline exits                                                |
| ---------------- | --------------- | ----------------- | -------------------------------------------------------------------------- |
| Morning ORB      | 11:28 hard exit | 11:28 hard exit   | Native protection plus application exits, including 60-minute maximum hold |
| Midday Reversion | 15:55           | 12:55             | Broker-managed brackets/OCO                                                |
| Noise Area       | 15:58           | 12:58             | Broker-managed brackets/OCO                                                |

[Close window](../../../../services/bayn/src/observe-composition/execution-cycle.ts) begins the release process,
not the liquidation fill. At the timed boundary the writer drains working entries, settles native protection,
obtains an exact residual, then prices, risk-checks, binds, and submits a closing limit. The
[protection interpreter](../../../../services/bayn/src/observe-composition/position-protection-interpreter.ts)
cancels one group per pass and requests a post-mutation refresh with a 5-second fallback wake; the refresh/event
can wake it sooner. A previously released leg can therefore wait unprotected while remaining groups settle.
This is a verified serial dependency and risk window, **not** proof of an observed race or 5 seconds of delay per
leg. Submitting a full-size close before terminal protection could race a child fill and reverse inventory; do
not remove the barrier.

The [fast release readback](../../../../services/bayn/src/execution/protection-release.ts) proves unchanged
posted fills, terminal group members, cash, position and no open orders against a prior exactly reconciled book.
The protected close fast path is sandbox-only, single-position, and excludes broker-managed Midday/Noise. A
scheduled `closeDue` cancellation does not carry a management trigger into that fast path. An earlier managed
exit can latch the application path, and `PROTECTION_RELEASED` labels that path, not the reason for the exit
or the time the fill was submitted. The retained [PAPER exit attribution](../2026-11-26-performance/README.md#exit-attribution)
contains roles and P&L, not the cancel-accepted → residual-verified → submitted → filled timestamps. Do not
attribute those historical losses to the close path or quantify seconds of realized latency from OHLC.

For timing sensitivity, freeze the last close before the deadline and compare stressed opens at +1/+2/+5
minutes. This tests adverse movement through a **stale** 10 bp cap; Bayn prices the closing limit with fresh
adverse quote evidence (or the existing reconciled-mark recovery exception), not this stale bar. Positive
incremental dollars are worse than the same leg at +1; unavailable or out-of-session marks are never priced.

| Cohort                       | At +1, within 10 bp / priced | p95 adverse move at +1 | At +2, within 10 bp / priced | Matched +2 adverse USD |
| ---------------------------- | ---------------------------: | ---------------------: | ---------------------------: | ---------------------: |
| Live Morning maximum hold    |                      26 / 36 |               22.26 bp |                      26 / 35 |                +$37.04 |
| Live Morning 11:28 hard exit |                        0 / 1 |               11.92 bp |                        1 / 1 |                −$53.21 |
| Live Midday                  |                    135 / 185 |               39.26 bp |                    130 / 185 |                 −$6.75 |
| Live Noise                   |                      44 / 51 |               11.40 bp |                   past close |                      — |
| Historical regular Midday    |                1,104 / 1,405 |               21.37 bp |                1,050 / 1,404 |               +$357.80 |
| Historical early Midday      |                       8 / 13 |               15.19 bp |                       8 / 13 |                +$74.44 |
| Historical early Noise       |                        5 / 5 |                5.39 bp |                   past close |                      — |

At +5 all Midday trials are at/past regular close; on the 36 matched live Morning maximum-hold
probes it costs +$264.67 with a 46.20 bp 95th-percentile adverse mark. Noise has only one full
post-deadline minute before the cutoff at either regular or early close. These are minute-level
budget sensitivities, not a finding that the 5-second fallback costs a minute.

## 4. Midday whole shares and collateral

The pre-quota scan found 1,814 true 2L+2S signal windows (not unique trades), 163 two-leg and 44
single-leg windows. Feed each four-leg window to the real funding, pairing, and target-planning code.
At $100k equity and sufficient buying power, all 1,814 preserve four intents, but **all 1,814** have
unequal sides: 1,073 long-underweight, 741 short-underweight. Median absolute residual **$314.13
(44.20 bp of gross)**, p95 **$1,152.16**, max **$1,873.58**. Relative to 4 × $18,000, the median
unused allocation is **$956.24**; 225 of 7,256 legs lose at least a whole share's value versus
unrounded reference weight, including the long funded-limit cap. These are planned quantities;
independent fills can create much larger residuals ([W1A](../2026-11-27-midday-beta-neutral/README.md)).

| Equity / buying power | Four intents | Reduced to one or two | Insufficient buying power | No funded legs |
| --------------------- | -----------: | --------------------: | ------------------------: | -------------: |
| $100k / $400k         |        1,814 |                     0 |                         0 |              0 |
| $100k / $90k          |        1,814 |                     0 |                         0 |              0 |
| $100k / $89.5k        |        1,699 |                     0 |                       115 |              0 |
| $100k / $80k          |            0 |                     0 |                     1,814 |              0 |
| $2.5k / $2.5k         |          199 |                 1,609 |                         0 |              6 |
| $1k / $1k             |            0 |                   271 |                         0 |          1,543 |

The [funded plan](../../../../services/bayn/src/strategy/intraday-alpha/exit-plan.ts) floors to whole shares
at the entry bound and caps shorts by per-leg collateral. The decision keeps equal funded counts where
possible, or a fallback single. The [planner](../../../../services/bayn/src/target-planner/planning.ts)
instead rejects the whole plan when buy requirement plus 150% short collateral exceeds buying power;
nominal 2 × $18k + 1.5 × 2 × $18k is $90k before rounding. It does not trim one leg to fit headroom.
The balance gate tolerates a sum of opposing share ticks; it does not guarantee exact or beta-weighted
neutrality. The low-equity rows are sizing stress, not executable mandate configurations.

## 5. Fees: observed ledger vs rate model

[Bayn fees](../../../../services/bayn/src/strategy/execution-model/fees.ts) match the published
[SEC Section 31 rate](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2) of **$20.60 per $1M sold
(0.206 bp)**. TAF is **$0.000195 per share sold** (cap **$9.79 per order** in the retained model), **zero
October 1–December 31, 2026**, and resumes January 1 under the
[FINRA rule filing](https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf). CAT is **$0.000003 per share
on each side**. Longs pay SEC/TAF on exit; shorts pay them on entry, not on cover. At the same per-share price
`P` on both sides, unrounded full-trip drag on sale notional is `0.206 + 0.060/P` bp while TAF
is paused, and `0.206 + 2.010/P` bp when TAF applies below its cap. The
[Alpaca fee disclosure](https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf) aggregates by type
and account/NY trading day and rounds each type upward to cents. Per-plan admission can conservatively
round standalone estimates; an actual accounting comparison must not round each fill.

The [retained performance ledger](../2026-11-26-performance/README.md) records **$195.93 over 2,693 equity fills**
(69 cash-fee activities; **7.2755¢ per equity fill in aggregate**). The published aggregate has no matched
sell-dollar/share denominator or fee-type allocation, so it cannot identify realized effective bps or split
SEC, TAF and CAT. The exact modeled drag at full share/notional is distinct from that observed aggregate.

The base cohort sizes range from 9 to 304 shares (median 50), with median reference notional
$17,856.78. The 293 supported post-decision round trips have $6.210M entry notional and **$130.44**
of modeled daily-aggregated cash fees, **0.210 bp** per entry dollar. January uses Bayn’s dated
model with unchanged SEC/CAT rates. Isolated round-trip examples,
one trade on an otherwise empty day, show the separate cent minima:

| Size × price | Sale notional | Nov 25 SEC + TAF + CAT | Nov RT bp | Sep 30 / Jan 4 RT bp |
| ------------ | ------------: | ---------------------: | --------: | -------------------: |
| 10 × $40     |          $400 |  $0.01 + $0.00 + $0.01 |     0.500 |                0.750 |
| 50 × $150    |        $7,500 |  $0.16 + $0.00 + $0.01 |     0.227 |                0.240 |
| 50 × $300    |       $15,000 |  $0.31 + $0.00 + $0.01 |     0.213 |                0.220 |

## Implementation and v3 recommendations

1. **Separate entry tolerance from stop coverage.** Reuse the pure
   [ATR helpers](../../../../services/bayn/src/strategy/execution-model/adaptive-collars.ts).
   In a versioned policy, compare 15/20 bp, the 35 bp stress, and ATR-adaptive against 10 bp on
   prospective NBBO and authoritative submit timestamps. Keep inward broker rounding and recompute
   funded shares and risk for each candidate bound; do not just raise the account-wide 10 bp cap.
2. **Measure an activated stop that is still working.** Preserve the executable-price checks from the
   harness: neither clamp a non-marketable recovery to a fill nor charge the entire wider limit when
   both limits clear the same price. Trial 25/50 bp and 0.25 ATR14 separately from entry tolerance.
   Record activation, priced marketability and unresolved duration; consider bounded cancel/reprice
   only after exact broker terminality and residual ownership. Cost, tail exposure, and fill rate all matter.
3. **Instrument release before changing the clock.** Bind an owned position's scheduled due, cancel
   acceptance, exact terminal residual, close pricing, submit, and fill timestamps in one joined
   receipt. Measure time without native protection and the oldest released leg in a basket. Compare
   15:57/12:57 vs the current Noise window in replay and PAPER before any versioned rollout. Do not
   relax fresh account/quantity proof or try to close against a possibly live child.
4. **Size paired baskets together before submission.** Compare a deterministic whole-share
   downsize under aggregate buy/collateral headroom against all-or-none rejection; constrain
   residual dollars and keep explicit separate authorization for any single-leg fallback. Record
   planned imbalance separately from post-fill orphan exposure; do not use IEX size to resize NBBO fills.
5. **Keep daily fee aggregation and exact settlement.** Use dated fee rates and NY trade date, retain
   cents per fee type, and obtain dated sell dollars/shares and fee activities before reconciling the
   $195.93 aggregate to SEC/TAF/CAT. No fee rate, funding gate, or execution mandate changes here.
