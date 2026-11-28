# Wave 19R protocol: daily next-open ETF pullbacks

## Trial registry

The only candidate that can advance is **RSI2-10**. **RSI2-15** and **RSI2-20** are sensitivity variants, not
replacement candidates. These are exactly **three strategy trials**. The four cost scenarios are stress tests
of the same rules, not a search over costs. No threshold, exit, sizing convention or universe substitution may
be picked based on the observed returns.

- Start with `SPY, QQQ, IWM, SMH, XLK, XLF, XLE, XLI`, in that order. Use only the authenticated Bayn Alpaca SIP
  daily (`adjustment=all`) and 5-minute (`adjustment=split`) archives and their official session calendars. The
  5-minute data supply observed regular-session pricing, not intraday signals or orders. Use the open of the
  bar starting exactly at the regular open and the last observed close in the final two 5-minute bars of each
  regular session, including early closes. The coverage-only audit found a partial archive outage at the end of
  2019-08-12, after all eight opening bars. On that date alone accept a valuation mark from the latest observed
  bar in the final 35 minutes. This exception is neither a fill nor a signal input; record every nonfinal mark.
  Exclude any candidate missing a required price on any date; never fill from another symbol, a later opening
  slot, or a prior day. Missing SPY or incomplete control evidence invalidates the run. Require all eight
  candidates to advance.
- On completed session `t`, use the adjusted daily close. A flat name qualifies when its close is strictly above
  its 200-session SMA and Wilder RSI(2) is strictly below the trial threshold (seed with the mean gains and
  losses of the first two close changes; flat RSI is 50). All indicators include `t`, never `t+1`.
- At the next regular open, buy eligible names and sell those whose prior close was strictly above their
  5-session SMA, or which completed their fifth holding session at that close. The entry session counts as
  session one; the earliest exit is the following open. A name held at the decision close is not an entry
  candidate, even if it is scheduled to exit. Do not rebalance a held lot or close it artificially at the
  end of the tape. Report any open lots separately from completed-trade statistics.
- Size each entry by its share of total inverse volatility across all admitted names (20 adjusted
  close-to-close simple returns, sample standard deviation; zero volatility receives no allocation).
  Fix the weights at the signal close. At the next open, apply the weights to pretrade equity; scale new
  orders pro rata to available cash, after booked exits and fees. Use fractional split-adjusted units in one
  fully funded, long-only cash ledger with no leverage or idle interest. No ticker has an opening and closing
  trade in the same session. This does not model broker order feasibility, settlement, or cross-account activity.
- Mark candidate equity from the observed split-adjusted regular-session prices. Do not invent cash dividends
  or claim total-return P&L for the sleeve. The signal series includes vendor dividend adjustments. The
  09:30 bar open is an observed opening-period trade proxy, not a listing-exchange auction receipt.

## Windows, controls and inference

- Full history: 2,741 sessions, 2016-01-04 to 2026-11-25. Keep the initial 199 signal-warmup sessions as cash;
  the first possible entry is session 201. Score calendar years 2016–2026, with partial 2026 explicitly labeled.
  Use 2016–2023 (2,012 sessions) to fit inference parameters and 2024–2026 (729 sessions) as the chronological
  holdout. Run positions continuously across the seam. No rule is fitted to any of these windows; the archive
  was used in prior Bayn work, so this is not a new independently blind sample or a prospective test.
- Reproduce the original `B0/30/1.4/opposite_band/inverse_vol_parity` Noise Area, `F4-42-1-LQD-parity` with
  SHY idle carry, and Wave 5D `O1` with its registered SHY sweep, on the same dates. Require published return
  parity, not a related strategy, aggregate-only return, or substitute. Use daily passive SPY total-return
  marks. B0 uses its fixed-capital daily return denominator; F4 and O1 are compounded. These are isolated
  reference paths, not claims about sharing orders, inventory or capital.
- Run 0/2/5/10 bp **one-way** all-in candidate costs on executed notional. Replay controls at matched friction
  (twice the one-way bp passed to their round-trip APIs) and retain their registered sell fees. Report
  calendar CAGR, 252-session annualized sample volatility, Sharpe and Sortino at zero cash rate, absolute
  maximum drawdown, Calmar and annualized one-way traded notional / pretrade equity. Count wins and sum gains
  vs losses by closed net trade; attribute them to the exit window. Find a bracketed one-way breakeven on
  separately compounded Full and Holdout returns by repricing the ledger between 0 and 1,000 bp. Report as
  unavailable if gross return is nonpositive or the upper bound does not bracket zero.
- For each cost, derive the Bailey–López de Prado deflation benchmark from the dispersion of the three
  development daily Sharpes, using exact `N=3` and no estimated effective-trial discount. Evaluate standalone
  DSR against this fixed benchmark. It does not adjust for every prior Bayn study or for serial dependence.
  Report date-matched Pearson correlations and one-sided stationary-bootstrap mean p-values (10,000 draws,
  mean block five sessions, seed `0x19a2026`) for standalone returns and joint residuals. Fit a regression with
  intercept on development against `SPY`, `B0`, `F4` and `O1`; freeze the slopes and subtract their same-date
  contributions **without** subtracting the intercept. Holdout residual mean × 252 is the annualized alpha
  estimate. This conditions on fitted development exposures; it is not the realized return on a hedge.

## Decision

**PROMOTE** means advance only to prospective shadow research. At **both 5 and 10 bp one-way** the primary
must show positive Holdout CAGR and positive joint residual alpha, and absolute Holdout correlation below
0.30 with each of B0, F4, and O1. At **5 bp** it must also reach Holdout standalone DSR ≥ 0.95 and joint
residual p < 0.05. Require all eight verified ETFs and zero candidate same-session round trips. Any unmet or
unavailable gate yields **DO NOT PROMOTE**. Even a pass would need forward execution and dividend evidence
before requesting any strategy, policy, or capital change.
