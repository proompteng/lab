# Wave 11B preregistration: intraday ETF volatility targeting, close momentum and pairs

## Scope and freeze

This is fixed-capital, pure-ETF research, not a live trading recommendation. No strategy holds intentional
overnight positions. No single stocks, leveraged ETFs, auctions, overnight return P&L, or single-stock event
filters enter the tests. The underlying historical sample has been used in earlier Bayn studies; “Holdout”
means not accessed for Wave 11B selection, not previously unseen to the organization.

| Window     | Dates                    | Official sessions |
| ---------- | ------------------------ | ----------------- |
| Train      | 2016-01-04 to 2021-12-31 | 1,511             |
| Validation | 2022-01-03 to 2023-12-29 | 501               |
| Holdout    | 2024-01-02 to 2026-11-25 | 729               |

Use the Wave 6A SHA-256-pinned split-adjusted consolidated SIP 5-minute manifests, exchange calendars and tapes
from the `agents-artifacts` S3 bucket: development `bayn-research-datasets/2026-11-27-sip-8yr-5m-unseen-v2/`;
Holdout `bayn-research-datasets/2026-11-27-sip-multiyear/`. Authenticate all 174,598,869 development
bytes; decode its complete 174,597,176-byte gzip member, not the authenticated trailing 1,693 bytes. Use the
SHA-256-pinned split/dividend-adjusted daily SHY tape from `bayn-research-datasets/2026-11-27-sip-10yr-sp100/`
only after the freeze check.

Both 5-minute **manifest rosters** were inspected before writing this protocol. All traded symbols (SPY, QQQ,
IWM, SMH, XLK, TLT, IEF and GLD) are in both. Neither roster includes SLV or HYG, so omit GLD/SLV and HYG/IEF
even though their missing legs occur in the daily archive. Require presence in every official session and both
end dates in each 5-minute split. Both tapes have full session span for these ETFs in the prior published
coverage audit, but not literally every development bar. Count missing bars; use no imputation, outside-tape
repair, or dropping official sessions. If a required input is absent, withhold the signal. If a required
entry open is absent, no fill; if a required final exit cannot be proved, mark the leg unresolved and do
not compute full-window P&L for the affected configuration.

Commit the protocol and locked implementation before `--freeze`. Commit the generated Train/Validation
`freeze.json` before reading any Holdout price or scoring. The runner checks the raw SHA-256 of working
files against committed blobs and frozen source digests, and independently reproduces the full development
receipt from development bars before reading Holdout prices. After a squash, the same committed content
passes; there is no branch or commit-ancestry dependency. Carry causal feature histories, not positions,
across both split seams.

## Shared fills and control

Start each strategy with a fixed $100,000 gross-budget unit, no reinvestment, no transfer of unused symbol
budgets. Buy/short whole shares using the smaller share budget at the signal close and 10 bp adverse-cost
entry open. Signals observe completed bars, then trade the following bar open (a bar timestamp is its start).
Each open fill carries an adverse half of 2, 5, or 10 bp, applied to that fill's actual pre-friction traded
notional. Add the existing modeled 0.21 bp sell charge on the adverse sell fill. Recompute quantities when
leverage changes; do not scale already rounded daily net P&L. Mark gross by summing per-leg held highs as
a conservative bound; the leverage ceiling is on allocated entry notional, not a live mark-to-market or
broker buying-power guarantee. These are bar fills, not executable quotes; borrow, impact, finance, auction
access, margin eligibility and latency are not inferred.

Reproduce Wave 6A B0 (`B0/30/1.4/opposite_band/inverse_vol_parity`) to the cent at 2/5 bp on
Train and Validation, then Holdout and Full. Use the prior 14 sessions of same-time absolute move, a gap-aware
1.4× band, inverse-vol parity, next-open breakout entry, opposite-band exit, and the original scheduled
close-minus-15-minute flatten with at most three exit opens. No changes to the B0 paths across sizing variants.

## A — Realized strategy volatility targeting (12 variants including controls)

[Zarattini, Aziz and Barbon](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172) motivate daily
volatility sizing of the Noise Area. This variant targets the realized P&L stream of each _fixed-1x_ basket,
not the paper's underlying volatility measure and not Wave 9B's weighted underlying-return proxy. Independently
run QQQ/SMH and QQQ/SMH/XLK with their fixed-1x controls plus the same five (annual volatility target, cap) pairs:

| Target | Gross cap |
| ------ | --------- |
| 10%    | 2.0×      |
| 15%    | 1.0×      |
| 15%    | 1.5×      |
| 15%    | 2.0×      |
| 20%    | 2.0×      |

Hold signals and per-symbol risk shares fixed. At the open compute sample volatility × sqrt(252) from the last
14 official sessions of fixed-1x P&L divided by $100,000, before quoted spread costs but including the modeled
sell fee. After the control's first 14 structural warmup sessions, include every resolved day (including zero
trades) in the window. A short or incomplete history means zero target allocation; zero measured variance
after a complete history uses the registered cap. Otherwise allocate `min(cap, target / realized)`. No
current-day observations enter the scaling decision. Compare dollar P&L, Sharpe, Calmar and drawdown with
the fixed-1x control of the same basket, and show how often sizing hits its cap.

## B — Close momentum (10 variants)

[Gao, Han, Li and Zhou (2018)](https://doi.org/10.1016/j.jfineco.2018.05.009) use the first half-hour
return as a predictor; this is not a replication. [Baltussen et al. (2021)](https://doi.org/10.1016/j.jfineco.2021.04.029)
motivate testing the same-direction return into the last half hour; this tape cannot identify actual
leveraged-ETF flows. The directional proxy is each ETF's return from previous official close to the
completed bar ending at 15:30 ET (12:30 on early closes). Buy/short at the 15:30/12:30 open if the
absolute return meets its 0.5×/1.0×/1.5× cutoff against the sample standard deviation of the same
close-relative signal over the prior 14 official sessions, using each session's scheduled close. Do not
trade zero returns or zero signal volatility. At 15:55/12:55 flatten at the open; do not infer a 15:58
or auction fill from a five-minute archive. Allocate equal fixed budgets within each of three distinct
baskets: index (SPY/QQQ/IWM), tech (QQQ/SMH/XLK), cross-asset (TLT/GLD). The tenth variant uses the
index basket at 1.0× with a same-day open anchor instead of previous close. An intermediate missing
mark is counted; unlike a missing entry/exit or a missing held-path decision in A/C, it does not
obscure any B order because B has no held-path signals.

## C — Intraday spread reversion (eight variants)

[Gatev, Goetzmann and Rouwenhorst](https://doi.org/10.1093/rfs/hhj020) motivate related-pair mean reversion,
not a replication of their daily selection. Run each of SMH/QQQ, XLK/QQQ, IWM/SPY and TLT/IEF at 1.5 and 2.0σ.
At the open, set each leg's fixed weight proportional to the inverse standard deviation of its prior 14
official open-to-close returns (require nonzero complete observations). Compute a weighted log spread:
`wA × log(A/A_open) − wB × log(B/B_open)`. Apply today's pre-known weights to today's and all 14 historical
spreads at the same completed clock. Skip scheduled sessions that did not reach that clock, not missing
bars on sessions that reached it. Standardize by the sample mean and standard deviation of those prior
spreads; zero spread variance is not a signal. Opposite-sign positions are approximately **vol-neutral**,
not dollar- or market-beta-neutral.

From 10:00 through 14:30 ET, shortened to the final 5-minute entry clock before the timed exit on early
closes, enter once per pair per day at the next common open: short the rich spread, long the cheap spread.
If either entry open is missing, cancel the pair for that day. Request exit on the first completed spread
at or through its same-clock mean. Fill both legs at the next common open or at the 15:55/12:55 deadline,
whichever comes first. If the deadline's paired fill cannot be proved, both legs remain unresolved for
reporting. A missing held bar can obscure a mean cross, so the configuration is not execution-safe in that
window even if a later exit was priced. Charge both orders on each leg at the same friction as A/B.

## Selection, inference and qualification

Rank non-control configurations separately by family: keep the top three eligible Train Sharpes at 5 bp and
nominate the best Validation Sharpe from those three (lexical tie-break). Eligibility requires defined
Sharpe and resolved execution in both windows, and no missing held-path decisions for A/C. Zero-trade
sessions remain on the scorecard. If no candidate qualifies for nomination, do not replace it after seeing
Holdout. Show all registered sweeps as descriptive diagnostics; only nominees can qualify.

At **both 2 and 5 bp** on Holdout require positive net and positive net after removing the top ten profitable
days, one-sided centered circular stationary bootstrap `p < 0.05` against zero net daily P&L (10,000 draws,
mean block length five official sessions, deterministic seed `0x6a202611`, plus-one p-value), and daily
skew/kurtosis-adjusted DSR `>= 0.95`. Freeze the DSR benchmark at each cost using dispersion of defined
Train Sharpes across the 30 − 2 control = 28 non-control trials and the expected maximum of 28 standard
normal trials. This adjustment covers only this wave, not the broader research program or dependence
across trials. Require execution-safe Holdout rows for the candidate and comparison control.

For B/C also require absolute daily net correlation with B0 strictly below 0.30 and positive annualized
Sharpe lift for the equal-funded portfolio of candidate plus B0 over B0 alone, on aligned official sessions
at both costs. This stack is two funded sleeves, not a shared-gross or execution netting simulation.
For A also disclose paired candidate-minus-matched-control P&L and its one-sided stationary bootstrap
p-value, not used to choose or qualify a nominee; standalone qualification does not by itself imply
improvement over fixed sizing. All 10 bp numbers are stress diagnostics. Calmar uses linear annualized
P&L divided by max dollar drawdown. SHY is a distinct $100,000 funded daily total-return overlay for
controls and nominees only, with no entry on the first observation and no impact on selection or qualification.
