# Wave 9A protocol: pure-ETF overnight vs continuous and intraday B0

**Retrospective registration.** Freeze this protocol before computing Wave 9A outcomes. Publish the executable
and Train/Validation receipt before reading or scoring Wave 9A Holdout intraday bars. The daily objects span
all years; the development decoder admits only dates through 2023-12-29. The Holdout period was already studied
in earlier waves, so the chronological freeze prevents tuning in this run, not historical selection bias.

## Sample and prior engines

- Frozen Alpaca SIP daily `adjustment=all` base plus DIA/UUP supplement, and split-adjusted 5-minute exact-62
  2016–2023 and 2024–2026 RTH archives. Reuse Wave 5C and 6A authenticated readers and exchange calendars.
  Authenticate all 1,693 trailing bytes of the development gzip object but send only its single 174,597,176-byte
  gzip member to the decoder. Require all 8,641,719 development and 3,923,737 Holdout physical rows.
- 2,741 sessions from 2016-01-04 to 2026-11-25: Train 1,511 (2016–2021), Validation 501 (2022–2023),
  Holdout 729 (2024–2026). Also report calendar 2022 and all 11 calendar-year returns. Preserve state at seams.
- Decompose all 29 ETFs with `O(t)/C(t-1) - 1` and `C(t)/O(t) - 1`. Never bridge a missing adjacent mark
  (XLC pre-listing and two XLRE gaps); there is no prior close for the first session. Report separate usable
  and paired counts, compounded legs, paired close-to-close identity, overnight share of paired log return,
  correlation, and each leg net of independently crossing twice at 1/2/3/5/10 bp round trip.
- [Wave 5C F2/F4](https://github.com/proompteng/lab/pull/16379) are exactly F2-42-IEF-100-10 and
  F4-42-1-LQD-parity with funded SHY idle, 10% prior-close rebalance band, and next-open execution.
  [Wave 5D O1](https://github.com/proompteng/lab/pull/16376) motivates the comparison; it is not an additional arm.
  [Wave 6A](https://github.com/proompteng/lab/pull/16387) B0 is the matched-primary QQQ+SMH
  30-minute/1.4×/opposite-band/inverse-volatility arm, not the B4 primary or the legacy C5.
- Prior studies motivate the question rather than establish this tape's answer:
  [Lou, Polk and Skouras](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf) study cross-sectional
  strategies; [Cooper, Cliff and Gulen](https://ssrn.com/abstract=1004081) document an historical US day/night split.

## Fixed comparisons (19 books, no selection)

| ID                              | Book                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C0-SHY, C1-SPY                  | Continuous buy-and-hold, buy once at the first open                                                                                |
| C2-SPY/QQQ/SMH/60-40 × cash/SHY | Four overnight-only targets, each with zero-yield daytime cash and actual daytime SHY variants; 60/40 is SPY/TLT and resets at MOC |
| C3-cash, C3-SHY                 | Credit/trend-gated MOC/MOO, two daytime idle variants                                                                              |
| C3-continuous                   | Same gated targets and MOC rebalances as C3, no opening liquidation; matches decision and rebalance timing for daytime attribution |
| F2, F4                          | Standalone Wave 5C representatives, continuous next-open                                                                           |
| C4-F2-B0, C4-F4-B0              | Same continuous core in a shared account with B0                                                                                   |
| C5-C3-B0                        | C3-cash macro core; B0 trades only after MOO and is flat before the next MOC                                                       |
| B0                              | Wave 6A constant $100k reference sizing, intraday only, no idle carry                                                              |

C3 takes HYG/IEF above its EMA100 (first 100 observed ratios seed by arithmetic mean), **and** SPY close
above SMA200 **and** SMA50 above SMA200. Risk-on is equal SPY/QQQ/SMH; risk-off is equal SHY/IEF/GLD.
Use 100% SHY until warmed. Inputs for MOC are from the **previous completed session** (not today's close);
the MOC before session `t` uses closes through `t-2`. There is no forced terminal purchase or sale.
Same ETF at adjacent horizons is netted; SHY is a traded ETF, never a cash yield proxy in the replay.

## Account, friction and clock

- Start at $100k. Continuous/auction ETF targets are mechanically filled on adjusted daily open/close proxies,
  fractional exposure, self-financing after fees. Split-adjusted intraday fills use whole-share quantities and
  the existing next-bar rules and quote/reference reservation. Netted ETF targets are accounted in one cash
  ledger; opening ETF allocations and B0 P&L share the same account (not the sum of isolated equity curves).
  In C4, use existing cash first and fund any debit after B0 closes with a pro-rata core sale at the closing
  mark, net of selling costs. Treat the sale as intraday financing turnover, not a change to F2/F4 signals
  or a proven auction-order sequence. No debit is carried overnight.
- Charge half each stated round-trip bps tier at each buy and sell, plus 0.21 bp on sells, using trade notionals.
  Gross sensitivity is 0 with no sell fee, otherwise 1/2/3/5/10 bp. Auction and B0 costs are **scenarios**, not
  auction prints or measured execution. One-way turnover is half absolute traded notional divided by prior NAV
  and annualized over elapsed calendar years; report costs and MOC/open/close-funding/B0 notionals by window.
- One-times fully funded overnight; overall modeled opening intraday envelope at most twice the smaller of
  prior-close and opening equity. Reserve core gross at both marks (use the larger), with no increase in that
  envelope from liquidating the core. B0 sizes off at most its $100k reference; C5 further caps reservations at
  MOO-released available cash, never using short-sale proceeds for sizing. Hold allocations for both B0 legs
  independently; no redistribution when a core-held symbol blocks an entry. Require zero cross-sleeve concurrent
  symbol overlap. Track order reservations, short cash stress, marked exposure warnings, missing entries/held
  bars and flat status. Missing exit for an executed leg is an error, not a zero; no execution patching.
- The first possible B0 fill is 10:00 ET. Use Wave 6A's scheduled close-minus-15-minute exit with retry on 5-minute
  opens through close minus five minutes, never treat 15:58 as a sampled execution price. Early closes follow
  the same relative clock. ETF `close→open` is the MOC/MOO **exposure** window, not proof of the 15:58 order
  handoff: [Alpaca documents CLS and OPG submission cutoffs](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
  of 15:50 and 09:28 ET on normal sessions. The two-times and one-times limits are study constraints, not
  [broker account readings](https://docs.alpaca.markets/us/docs/margin-and-short-selling). In particular C5 reuses
  same-day sale proceeds in a modeled margin account; it does not prove instant free buying power, settlement
  availability, historical locates, fills, impact, intraday maintenance compliance or live operational feasibility.

## Scoring and interpretation

- Window metrics rebase to $100k using the actual uninterrupted daily return path; use the prior marked close as
  the start date (first open for the full-series first day). Report final equity, CAGR, terminal excess vs SHY
  (USD and percentage points), annualized daily Sharpe and zero-hurdle downside-RMS Sortino, close-marked MaxDD
  (percent and dollars), Calmar, positive calendar years / observed years, Ex-Top-10 paired excess after removing
  the candidate's ten largest positive days, overnight-vs-intraday net Pearson correlation, and daytime beta
  versus SPY open-to-close. Costs at MOC and MOO belong to overnight; SHY daytime carry costs are accounted
  at its actual transitions. No future test outcome or realized price may alter signal or allocation rules.
- Report one-sided stationary circular-block paired p-values vs SHY and vs standalone B0: 10,000 resamples,
  mean block length five, fixed seed shared within a window, centered null with add-one correction. DSR is
  deflated daily **SHY-excess** Sharpe with the expected-max hurdle estimated solely from Train's cross-book
  Sharpe dispersion using 19 trials at each given friction tier. Undefined ratios are null, not zero.
  The bootstrap is a paired comparison of observed paths, not a test of production readiness.
- For C3, report the exact net log-wealth difference against matched continuous as gross clock difference plus
  incremental cost drag (including changed NAV/drift). For stack decisions, compare to both continuous parents
  and B0 on Holdout and 2022, with 2 and 5 bp primary readings; give return, risk, beta and churn tradeoffs.
  Do not claim superiority on a single metric or authorize trading. No strategy promotion, broker change or rollout.
