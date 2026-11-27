# Wave 3B preregistration: 46-stock SIP intraday portfolio

**Research only.** This is a retrospective, fixed-$100,000-equity bar study; no broker, mandate, or release is
involved. Wave 2C (#16361) and Wave 2D (#16360) already inspected these dates. Train selects the registry,
Validation is a promotion gate, and Holdout is a frozen synthesis check, not new prospective data.

## Tape and chronology

Use the signed-access, SHA-256-pinned consolidated Alpaca SIP 5-minute split-adjusted archive (62 symbols,
3,923,737 raw rows) and exchange calendar. Stream and verify compressed and raw bytes, clip to regular
trading hours, and keep missing slots missing. E1/E2 use the manifest's 46 stocks, E2 also reads SPY,
and E3 trades QQQ/SMH. ALAB starts March 20, 2024; GEV starts regular-way April 2, 2024; SNDK starts
regular-way February 24, 2025. Ignore earlier when-issued rows. WDC history resets at the Sandisk
distribution (February 24, 2025). Require exactly 14 consecutive, complete, strictly prior eligible
sessions; missing sessions do not advance warm-up. An early close is a complete shorter session; it cannot
provide nonexistent late Noise Area observations.

| Split      | Inclusive dates               | Sessions |
| ---------- | ----------------------------- | -------: |
| Train      | 2024-01-02 through 2025-06-30 |      374 |
| Validation | 2025-07-01 through 2026-03-31 |      189 |
| Holdout    | 2026-04-01 through 2026-11-25 |      166 |

Report these splits, the full window, and all six calendar half-years. The 2026 closing half-year is partial.
Score zero P&L on observed cash sessions, not on unresolved trades. No backfill, cross-split reset or compounding.

## Fixed experiments

- **E1 — 27 OR5 configurations:** Rank eligible opening directions by first-bar SIP volume / mean prior
  14 opening volumes, ties by symbol. Direction is the first bar's open-to-close sign; require an absolute opening
  gap of at least 0.5 prior ATR14 (simple mean of daily true ranges). Sweep K=1,2,3; RVOL thresholds 2.0,2.5,3.0;
  range stop and targets 2R,3R or timed flat. K is selected before the breakout, even if fewer than K trade.
  The first completed touch strictly beyond the direction's OR5 edge triggers the next open, unless the path
  before the touch is missing. Size whole shares on the signal-close distance to the opposite range edge;
  split the $1,000 sleeve risk and $180,000 sleeve gross budget by K, max $60,000 per name.
  A next open beyond the protective stop cancels the order. Compute R targets from the filled reference open.
- **E2 — 54 Extreme-2-Pair configurations:** At 11:30, 12:00, or 12:30 ET use the just-completed bar and
  cumulatively volume-weighted SIP VWAP; rank `10,000 × (close / VWAP − 1)` minus the equivalent SPY deviation.
  Require the two lowest scores negative, the two highest positive. Long the former, short the latter, equal dollars.
  Gate independently by either min pair spread (second-highest minus second-lowest score: 0/200/300/400/500/600 bp)
  or the eligible score IQR (0/50/75/100 bp; zero is the same ungated control and is counted once).
  Percentiles use linear interpolation. Cutoffs are inclusive. The only exits swept are 500 bp stop / 800 bp
  take-profit or timed flat with no bracket. Base gross is $180,000, one quarter per leg, fractional shares.
  In a portfolio exclude OR5 symbols held or already pending at the signal cutoff, then re-rank/re-gate.
- **E3 — four configurations:** At 30-minute closes use mean absolute move from the open at that checkpoint
  over the prior 14 sessions. Multiply by 1.0 or 1.2 and apply to max(open, prior close) above and min below.
  Enter once per ETF in the direction of the first band breach; exit at the next open after an opposite-band
  checkpoint, or use a fixed 1.5 ATR14 price-distance stop. Both modes flatten at the session cutoff.
  Whole-share size using ATR14 and $1,500 total sleeve risk split between ETFs; each max $60,000.

## Portfolio and execution

Rank E1 and E2 individually by the lower of Train Ex-Top-5 at 5 and 10 bp, ties by ID, null last.
Keep up to three finite choices per sleeve plus the respective Wave 2 controls (E1 top-1/2.5/2R and E2
noon/ungated/500–800), deduplicated. Cross these sets with E3 either off or one of its four registered
configurations. For both engine counts use the following book allocations, multiplying each sleeve's
own whole-share risk and/or notional limits:

1. Equal static weight.
2. Static OR5 tilt: 75% in the two-engine book or 50% in the three-engine book; split the rest equally.
3. Static reversion tilt: the same weights applied to reversion instead.
4. Moreira–Muir-inspired inverse variance: equal base weighted by
   `min(2, (0.005 / max(dailyVol, 0.0025))²)`; divide by the sum if above one, otherwise keep idle gross.
5. Inverse-volatility risk parity: normalize `1 / max(dailyVol, 0.0025)` across included sleeves
   (a diagonal-covariance approximation, not correlation-adjusted risk parity).

Daily vol is sample standard deviation of the previous 20 session standalone 10 bp shadow net returns on fixed
equity; no current-day contribution. The lag includes warm-up/cash days, and any unavailable history falls back
to equal base weights. The inverse-variance rule follows the form of
[Moreira and Muir](https://www.nber.org/papers/w22208), not their fitted scaling constant.

Next-bar opens are the only discrete signal execution points. Flatten at the last regular bar's **open**,
including early closes. Gap through stop fills at open; target is at limit or worse, without favorable price
improvement. Stop wins an ambiguous intrabar stop/target tie. A missing entry cancels (all four legs in E2,
an idealized atomic basket). Gaps after entry retain occupied symbols and gross and are counted; unobserved
intrabar hits are not invented. A missing timed liquidation leaves the day unresolved. Unresolved returns
propagate null, not zero. An intrabar exit frees capacity only after that bar; a known open exit can free
capacity for entries at that open but cannot change signals from the preceding close. Same-open priority
is E1 then E3 then E2; an OR5 signal that arrives while E2 holds its symbol is skipped, not delayed.

The book checks actual concurrent **entry-reserved** gross, not sum of daily turnover. Reserve each fill at the
opening price plus the maximum modeled half-spread (also for shorts), resize to the residual $180,000 across
all sleeves and preserve equal E2 leg dollars. This is a hard admission cap; positions are not force-rebalanced
on unrealized price moves. Charge each fill an adverse half of the 2/5/10 bp RT scenario, plus 0.21 bp on
the slipped sell side. Historical quotes, locate/borrow, participation, queue position and market impact
are not observed.

## Freeze, gates and diagnostics

`--freeze` routes only Train and Validation bars to the feature store. It records all development trial IDs,
both stress metrics in both splits, the shortlist, known input hashes, and hashes of the protocol and research
code. Commit the receipt before running `--score`. Score verifies that committed bytes match the working
receipt and reproduces the entire development calculation before reading any Holdout values. All registered
variants are reported after the freeze; Validation/Holdout never add or replace a configuration.

A portfolio is eligible only if frozen with strictly positive Net **and** Ex-Top-5 in both development splits
at both 5 and 10 bp. The same conjunction must hold on Holdout, plus at least five of six calendar half-years
must have jointly positive untrimmed net at both stresses. Report E1 target-band retention ($35k–$45k net at
10 bp) and independently apply the split conjunction to E2. An economic pass is not statistical significance
or live authority. Do not create candidate strategy code for an unqualified portfolio.

For each window/cost, report net, daily Sharpe annualized at 252 sessions, additive USD peak-to-trough MaxDD
(starting at $100,000), linear annualized P&L / MaxDD (Calmar), cost breakeven from fee-adjusted turnover,
and E1/E2/E3 standalone daily net Pearson correlations. Ex-Top-5/10 drop the highest five/ten daily outcomes
in that window at that cost. LOSO excludes each trade symbol globally and reruns signals, selection, overlap,
cap and causal weighting; the scorecard reports worst resolved net, known and positive counts. Inference:
one-sided 10,000-draw centered circular five-session block bootstrap, deterministically seeded; DSR uses the
[Bailey–López de Prado](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) non-normal Sharpe correction.
The null maximum uses the raw cumulative registered count from Waves 2C (347), 2D (2,055) and Wave 3B;
no assumed effective-trial discount for correlations. Use pooled sample dispersion of all defined trial-level
daily Sharpes at the same window/cost. [Prior moments](prior-sharpe.json) convert predecessors' published
annualized Sharpes to daily units. Wave 2D full-window daily Sharpe is reconstructed from split first and
second moments (split mean = net / sessions, sample SD = mean / daily Sharpe); windows with no defined
Sharpe remain absent from variance but not from the trial penalty. Both p and DSR are descriptive after
repeated archive inspection, not independent prospective evidence.
