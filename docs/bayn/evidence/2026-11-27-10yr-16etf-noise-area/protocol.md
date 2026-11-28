# Wave 6A preregistration: expanding 30-minute Noise Area Momentum

## Question and scope

Does a 16-ETF, 30-minute inverse-volatility Noise Area book improve on the two-ETF book outside development at 5 bp
round trip? This is retrospective research only; it does not change live v2, confer capital authority, or establish
an executable spread, financing, or short-borrow model. The [Zarattini–Aziz–Barbon signal](https://ssrn.com/abstract=4824172)
is adapted to completed SIP five-minute bars. [Wave 5A](https://github.com/proompteng/lab/pull/16377) already observed
QQQ+SMH in **both** tapes. The 14 expansion symbols are newly scored for this specific Wave 6A experiment, not
guaranteed never to have been researched (e.g. SPY appears in the original paper). The stitched result is descriptive,
not independent evidence. The fixed, named universe contains pre-2016 funds with no IPO entry rule or hindsight
replacement during replay. The inference is conditional on this supplied cohort, not proof of zero selection bias
over the population of all ETFs extant in 2016; the tapes cannot reveal omitted historical delistings.

## Dataset and boundary

Train is 2016-01-04 to 2021-12-31 (1,511 sessions), Validation 2022-01-03 to 2023-12-29 (501), and Holdout 2024-01-02
to 2026-11-25 (729). The 2,741-session union retains every official date, warm-up, and early close. Development uses
the immutable `2026-11-27-sip-8yr-5m-unseen-v2` exact-62 manifest, tape and calendar; Holdout uses the
`2026-11-27-sip-multiyear` exact-62 manifest, five-minute tape and pinned `calendar_2024_2026.json`. The download
authenticates the **entire** 174,598,869-byte development object, then decompresses its one registered 174,597,176-byte
member; the 1,693 trailing bytes are authenticated but not fed to zlib. Physical row counts include extended-hours
rows, which the calendar excludes from signals and fills. Carry uses the separate split- and dividend-adjusted
Alpaca SIP daily SHY archive (`2026-11-27-sip-10yr-sp100`); it is not required or read during selection.

Run `--develop` against Train and Validation only. The receipt binds exact archive manifests, protocol/code bytes,
the 90 grid definitions plus legacy control, the full development ledgers and frozen Train/Validation selection.
Commit and push the receipt and code before the first `--score` (no Holdout price read, parse, or score by this
study before that boundary). Score checks the exact published Git revision, original committed receipt and code, and
regenerates the complete development receipt before requesting Holdout bars. It carries feature state across both seams
without carrying positions; it cannot reselect variants from Holdout.

## Cohorts and 91 configurations

| Basket | Membership                                                                      |
| ------ | ------------------------------------------------------------------------------- |
| B0     | QQQ, SMH                                                                        |
| B1     | SPY, QQQ, IWM, SMH                                                              |
| B2     | SPY, QQQ, IWM, SMH, TLT, GLD                                                    |
| B3     | SPY, QQQ, IWM, SMH, XLK, XLF, XLE, TLT, GLD, USO                                |
| B4     | SPY, QQQ, IWM, SMH, XLK, XLF, XLE, XLV, XLI, XLY, XBI, ARKK, TLT, IEF, GLD, USO |

The identical 18-config fraction per cohort covers all three exits, both clocks and both sizing methods:
at `m=1.2`, use both clocks and both sizes for all three exits (12); at `m=1.0, 1.4`, use 30m inverse volatility
for all three exits (6). B0 contains the matched two-ETF application of the Wave 6A transfer rules. One additional
fixed, untuned B0 control reproduces Wave 5A C5: 30m, 1.2, opposite band, prior 14 complete consecutive sessions,
no late checkpoint if any of those sessions did not reach it, floor shares from $1,500/(2×ATR) and a $60k per-name
cap, original missing-open treatment and original clock. Wave 5A's nominal two-minute flatten rounded to the final
five-minute open on these tapes. Keep this control separate so sizing or clock changes are not attributed to basket
breadth.

## Causal orders and sizing

- Use the mean absolute return from RTH open to the completed checkpoint close over the prior 14 sessions that
  reached that clock time. Skip only scheduled shorter sessions for offsets beyond their close, not missing bars in
  sessions that reached the offset. Upper band = max(current open, previous regular close) × (1 + m × mean); lower band =
  min of those anchors × (1 − m × mean). A missing previous close, prior open or required checkpoint withholds the
  respective feature.
- Starting at 10:00 and ending at 15:00 ET (last actual grid time at or before close − 30m on early closes), consider
  the first strict breakout per symbol/day. Use the next five-minute bar's open, never the decision close. No
  second entry, same-bar reversal, overnight position, or use of the current close to construct its historical band.
- At subsequent checkpoints, exit after a completed bar closes beyond the opposite band
  (`opposite_band`) or also crosses/is through RTH VWAP against the position (`vwap_or_opposite`; cumulative
  volume-weighted archived bar VWAP, unavailable after a missing bar). For `band_with_1.5xATR_stop`, a completed
  five-minute high/low through entry ± 1.5 times prior 14-day ATR also triggers a next-open exit, never a stop-price
  fill. Original C5 uses only its legacy opposite-band and timing rule.
- Early or regular sessions must be flat **by** close minus five minutes. Development archive coverage exposed
  absent final bars, particularly for early-history ARKK. Before freeze, fix the same timed liquidation clock for
  all Wave 6A variants: first attempt at close minus 15 minutes, then retry a missing open at minus 10 and minus 5.
  A missing entry open means no fill; earlier signal exits also wait only for the first observed open before the
  cutoff. If none exists the trade and day's net remain unresolved; report closed-leg P&L separately, never infer
  an overnight return or a successful exit. Record missing entries and held-bar gaps. Unresolved windows suppress
  full-net and inferential metrics. Only the historical C5 control exits at the original close-minus-five open.
- Allocate a fixed $100k reference budget across eligible names (equal or inverse sample standard deviation of
  prior 14 official open-to-close returns, floored at 10 bp). Eligibility uses today's open and prior information;
  no reallocation to signal-bearing names or intraday compound sizing. Integer shares use the signal close and
  an entry dollar guard at the executable open, reserved with a 5 bp adverse adjustment per side for every
  scenario. C5 retains its original entry dollar guard only. The absolute concurrent gross ceiling is $180k:
  the $100k allocation (legacy max $120k) keeps reserve below that ceiling, and the sum of each held position's
  5m peak marked notional is a conservative bound for qualifying price coverage. A bound above the ceiling or
  a gap while holding vetoes qualification; five-minute data cannot verify the next executable bid or ask.
- Apply adverse half the RT bps to each fill and 0.21 bp on the actual simulated sell notional. Test 1/2/3/5/10 bp
  with unchanged quantities. This is an NBBO-scale **friction scenario grid**, not tape-matched NBBO execution.
  The supplied five-minute SIP bars do not contain quotes and the existing IEX quote archive is not consolidated.
  If obtainable, separately spot-check consolidated SIP NBBO at 15:00Z on the first trading session of
  calendar years 2016, 2021 and 2026 (first 10 quotes per ETF within the next second); use no quotes for training,
  selection or fills. Report coverage and missing evidence rather than extrapolating it.
- Zero-cash figures are pure intraday simulated P&L. SHY figures add the incremental dollar changes of a
  continuously held $100k SHY total-return sleeve, funded at the first observed close (no prior price, no first-day
  carry); no additional compounding of the intraday P&L. This is a collateral/carry **scenario**, not a claim that
  full SHY return is available without collateral, financing, capital and duration constraints.

## Selection, diagnostics and verdict

Before ranking, remove from each development split any date with an unresolved exit in **any** of the 91
development paths; this makes the dates identical for competing configurations. Keep the full official-calendar
scores separately, including unresolved days. The common mask is a development-only comparison and does not
fill prices; excluded dates are recorded, and missingness need not be random. Rank within each basket on
zero-cash after-fee Sharpe at 5 bp in Train, retaining its top three. Choose the best of
those in Validation at the same cost; ties use lexical IDs, unavailable scores rank last. Freeze each cohort winner
and a separate **primary B4 30m inverse-volatility** winner using the same rule within that subset. Report both exact
C5 and matched B0 (same primary parameters), plus matched B4 equal weights and the fixed B4-minus-QQQ/SMH cohort.
The matched-equal diagnostic is not tuned; when outside the registered fraction it is one additional evaluated
configuration (maximum 92 total including legacy). Singletons and omissions are diagnostic reruns of the fixed
primary (rerun weights from remaining members), never selection trials.

The primary conclusion requires all of: Holdout 5 bp alpha positive and positive ex-top-ten, DSR ≥ 0.95, positive
paired 5 bp improvements versus matched B0 and exact C5 (each stationary-bootstrap one-sided nominal p < .05),
and complete, gap-free held positions within the conservative gross ceiling across the full replay. All other
inference is descriptive; a positive headline from a different basket, other costs or SHY does not override the gate.

Report all costs and both carry branches on Train, Validation, Holdout, full and each calendar year (2026 partial).
Break-even RT is after fees (carry-inclusive only in the carry branch). Ex-top diagnostics exclude the five/ten
largest positive daily values. Sharpe is daily net over sample deviation × sqrt(252); drawdown is on the additive
fixed-capital path; Calmar is simple annualized dollar net divided by maximum dollar drawdown. Win rate and profit
factor use nonzero daily net observations; active days count at least one filled trade. Correlations are pairwise
complete daily standalone net at 5 bp, including zero-trade sessions. Plateau is the percentage of one-axis
registered neighbors with positive net and at least 80% of the selected configuration's positive Sharpe, at 5 bp;
band steps are adjacent. Train/Validation plateau uses the common development mask. Separately report the
alpha-only sensitivity on common resolved sessions across the frozen main books and the 14-name diagnostic,
with dates of all omissions; it cannot substitute for official-window inference. Holdout grid scores and plateau are descriptive and cannot affect frozen selection.

Use a 10,000-draw one-sided centered circular stationary bootstrap (geometric mean block 5 sessions, seed
`0x6a202611`, plus-one adjustment). Share draws for paired comparisons and report alpha tests by split and full
at all main costs, and 5 bp for ablations. Do not infer skill from additive cash carry. For DSR use the expected
maximum null daily Sharpe from the dispersion of resolved Train Sharpes and all 90 searched grid trials; freeze
this benchmark and report DSR (including cumulative year-end paths) without fitting it to Holdout. This adjustment
covers this grid, not arbitrary unpublished research or earlier waves.
