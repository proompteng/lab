# Bayn Wave 3C: Registered multi-asset ETF protocol

This is a retrospective research screen, not trading authority or a claim that published effects still exist. The frozen
universe comprises the 27 ETF tickers in the supplied Alpaca SIP manifest. The fixed universe is not survivorship-free.
No closed fund is backfilled with a proxy. The replay checks the manifest and both SHA-256 hashes before using any rows.

| Partition      | Inclusive dates          | Sessions |
| -------------- | ------------------------ | -------: |
| Train          | 2016-01-04 to 2021-12-31 |    1,511 |
| Validation     | 2022-01-03 to 2023-12-29 |      501 |
| Frozen Holdout | 2024-01-02 to 2026-11-25 |      729 |

The trading-session clock uses the complete SPY date spine in the pinned dataset. XLC is not available until 2018-06-19;
XLRE has two missing observations (2016-01-25 and 2016-02-16). Missing indicator history is unavailable, never forward
filled. A missing price needed for an execution or mark aborts evaluation. The two remaining November 2026 scheduled
sessions (Nov 27 and 30) are calendar offsets only, not price observations. See the
[NYSE calendar](https://www.nyse.com/publicdocs/nyse/ICE_NYSE_2026_Yearly_Trading_Calendar.pdf).

## Execution and economics

- Close-of-session signals enter/resize/exit at the following session's adjusted SIP open. Prices strictly after the
  decision are never inputs except for execution and marking. A daily SIP open is a historical consolidated trade-price
  proxy, not a venue opening auction print, NBBO observation, or proof of available fills or borrow.
- Fixed research capital is $100,000 (no compounding or reinvestment). Change only target weights that changed since the
  last decision; unchanged shares drift with marks. At an execution open, if the marked and rebalanced gross exceeds
  $180,000, reduce positions pro rata as a mechanical risk check. Report trims and peak post-trade gross; intraday price
  excursions are not constrained by daily marks. Shares are fractional. No separate debit funding, commissions, taxes,
  or locate premia beyond the supplied costs are modeled. These assumptions do not confer leverage or short authority.
- Stress all registered trials at 5, 10, and 20 bp round trip (half applied to absolute executed turnover on each side),
  plus 0.21 bp on sell orders, including short sales, and 1.5% ACT/365 borrow on opening short notional. Count weekends
  and holidays in the borrow clock. Opposing sleeve orders net at the portfolio level before charging costs.
- Assign returns to the interval's first open. Indicators and hypothetical strategy state warm through prior partitions,
  but each partition starts economically flat and opens the prior close's target if available. A precommitted flatten at
  the last open of every partition charges all exit costs and uses no price from the next partition. The 729th Holdout
  session is liquidation only, not an extra earned interval. Year buckets use the same ledger without artificial
  flattening on intervening year ends.
- The base ledger earns 0% on idle capital. A separate ledger can buy SHY as a short-Treasury proxy with unencumbered
  capital (gross, not net, is subtracted from equity; short sale collateral earns nothing). Buy at the first open or
  a strategy rebalance, trim at opens when available capital contracts, and liquidate with the portfolio. Debit the
  same turnover and sell costs and net deliberate SHY buys/sells against overlay trades. No diagnostic SHY yield enters
  qualification. Report deliberate SHY P&L from risk-off selection separately even in the base ledger.

## Registered trials and plateau

| Signal            | Grid and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Trials |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| Trend risk parity | Long/flat or signed; 20/60/120/200-session price return sign or unweighted four-sign vote (tie flat); targets 10/12/15% annual volatility. Core universe SPY, QQQ, EFA, EEM, TLT, IEF, HYG, LQD, GLD, SLV, DBC, USO, VNQ. Weight by inverse 20-session close-return sample vol and scale by trailing portfolio covariance before the 1.8x cap. Recompute every fifth close. Preserve same-sign targets less than 5 percentage points from the new target; entries, exits and reversals bypass deadband.                                                                                                                                  |     30 |
| Pension month-end | Signal at close −5/−4/−3 (last session is 0), open next session; flatten at first open of next calendar month. MTD is from the preceding month's final close. Require a SPY-minus-TLT spread of ±2/3% or larger. Either long laggard at 100% or long laggard/short leader at 50% per leg.                                                                                                                                                                                                                                                                                                                                                |     12 |
| Turn of month     | Open on session −2/−1 and earn through +3/+4 (first session of new month is +1). SPY and QQQ hold inverse-20-day-vol weights at 10/12/15% portfolio vol; either unconditional or requiring SPY above SMA200 at entry signal.                                                                                                                                                                                                                                                                                                                                                                                                             |     24 |
| Uptrend pullback  | SPY, QQQ, IWM, SMH, XLK, XLF, XLV, XLI, XLY, XLE, GLD. SMA100/200 uptrend and Wilder RSI(2) below 10/15 or 3-session price loss over 1.5 times 14-session mean true range. Up to four positions, priority by RSI then registered ticker order. Size each entry at min(25%, 5% / trailing vol). Exit on Close > SMA5 or RSI(2) > 70 (compare the two rules), whichever registered rule fires first, or seven held sessions. No same-close reentry. Compare standalone with a 10%-vol version using SPY as hedge only: beta from 60 close returns, constrained to [0, 2] per long. Recompute hedge and scale only when membership changes. |     24 |
| Sector rotation   | Every fifth close rank 11 sectors, SMH and QQQ, with/without IWM, by 20/60/120-session return divided by trailing 20-session vol. Filter for positive return. Require HYG > SMA50 or SPY > SMA200 (separate rules); otherwise rank GLD/TLT/SHY instead. Allocate one-third capital to each of up to three picks. Missing filter history stays flat.                                                                                                                                                                                                                                                                                      |     12 |

These are discounted execution hypotheses motivated by published
[time-series momentum](https://fairmodel.econ.yale.edu/ec439/jpde.pdf),
[month-end institutional liquidity](https://academic.oup.com/rfs/article/33/1/75/5494694),
[month-end Treasury patterns](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3440417), and
[turn-of-month equity returns](https://business.purdue.edu/faculty/mcconnell/publications/Equity-Returns-at-the-Turn-of-the-Month.pdf).
The exact rules above are not claimed to reproduce those studies.

Primary ensemble blends all five signal families (pension and TOM are separate signals). Assign inverse volatility of
the last 60 **completed** paper-sleeve sessions at 10 bp; floor annual vol at 2%, normalize weights to sum to one;
use equal budgets until 60 observations and update every fifth close. Use closing targets, net, and cap at 1.8x gross.
The matrix contains all five arms, including the four structural mechanisms named in the mandate.

Each trial's neighbors change exactly one grid axis by one adjacent value in the published order (including mode and
filter switches). Ensemble neighbors replace exactly one arm by its immediate neighbor. The plateau requires at least
two-thirds of neighbors to retain positive net and Ex-Top-5 at 10 bp in **every** evaluated partition.
LOEO means rerunning selection, risk sizing and trading with each of the 27 ETFs removed as a tradable name and signal
input. SPY remains an external reporting benchmark and SHY remains an external idle-cash diagnostic even when excluded.
Removing a required filter, hedge, or pension leg disables that rule; no proxy is substituted. All 27 omissions must
have strictly positive net at 10 bp across all partitions for promotion.

## Selection, lock and admission

1. Commit this protocol and runner. Download the pinned dataset, decode only rows through 2023-12-29, compute the
   Train/Validation grid, and generate `freeze.json` with `--freeze`. Select one representative per family:
   prefer positive Train and Validation net and Ex-Top-5 at 10 bp with a stable development plateau, then passing the
   same positivity screen at 20 bp, then highest worse-fold 10 bp Ex-Top-5, then trial ID. Among the ranked rows
   satisfying the first criterion take the first with positive 10 bp LOEO for both development folds. If none exists,
   lock the first ranked row for diagnostics, without relaxing any gate. Form the all-five blend from these exact
   representatives; no dropping, replacing or reweighting based on Holdout.
2. Commit the development receipt before `--score`. The runner checks the first Git commit containing that receipt,
   replays the same development data and verifies byte identity. Score only the frozen representatives, ensemble and
   diagnostic neighbor and LOEO sets. No post-Holdout selection or calibration.
3. Qualification requires positive net and Ex-Top-5 in Train, Validation and Holdout at 10 bp; one-sided Holdout
   circular bootstrap p < 0.05 at 10 bp; all LOEO positive at 10 bp; and the registered 10 bp plateau. The full
   robustness objective additionally requires positive net and Ex-Top-5 in all folds at 20 bp and annualized one-way
   turnover of at most 12 times capital in each fold (one capital turn per month on average). No authority is granted
   by either result. An unsuccessful Holdout never becomes a new development partition for this study.

Net is fixed-equity dollar P&L after costs. Ex-Top-5/10 drop the five/ten best **net** days; negative residuals stay in
the sum. Sharpe uses daily returns on fixed capital and 252 sessions/year. MaxDD uses running fixed-equity account value
and peak percentage; Calmar divides annualized arithmetic return by that drawdown. Beta and annualized regression
intercept use matched open-to-open adjusted SPY (no benchmark cost). The terminal open has no benchmark interval.
One-sided 10,000-replicate five-session circular block bootstrap centers each period under the null of zero mean and
uses the fixed seed `0x2f12cb61`. The [Deflated Sharpe Ratio](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
uses daily Sharpe, skew and kurtosis; the fixed null benchmark uses the Sharpe dispersion across all development grid,
ensemble and ensemble-neighbor trials at each cost tier, counting every attempted trial toward multiplicity even if it
has undefined Sharpe. Cost tiers are stress scenarios, not selectable entries. DSR is diagnostic, not a promotion gate.
