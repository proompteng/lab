# Wave 18C protocol: calendar-event ETF premia

This registration fixes the rules, comparison paths, and decision before scoring. No rules, symbols, weights,
costs, or gates are selected from the results. The split called Holdout (2024–2026) is a fixed time check on
historical data, not independent of earlier Bayn research and not forward qualification.

## Data and clock

Use only the pinned Alpaca SIP archives used by [Wave 10D](../2026-11-27-10yr-orthogonal-pillar3/protocol.md)
and [macro ETF core](../2026-11-27-macro-etf-core-dual-horizon/README.md): adjusted daily OHLCV (splits and
dividends), split-adjusted 5-minute OHLCV, and the corresponding regular-session calendars. Check manifest
and tape digests, row counts, and matching session dates before scoring. Do not forward-fill a price or use
an unadjusted mark in an adjusted-price ratio. Missing required evidence aborts the run.

The price tape spans 2016-01-04 to 2026-11-25. Replay the controls from the start of the tape, but score every
series on the same 2,740 sessions starting 2016-01-05 (the first available prior-close-to-open pair). Train ends
2021-12-31, Validation is 2022–2023, and Holdout is 2024 through the cutoff. The 2026 row is year to date.
Positions and lookbacks carry across these dates. Report daily returns on the New York exchange-session date.
Only the verified calendar, not future price bars, can establish session ordinals or pre-holiday decisions.

Holidays are full-day market closures in the [NYSE trading calendar](https://www.nyse.com/trade/hours-calendars):
exchange-observed New Year's Day (no Friday observance when January 1 is Saturday), Martin Luther King Jr. Day,
Washington's Birthday, Good Friday, Memorial Day, Juneteenth from the 2022 exchange observance, Independence
Day, Labor Day, Thanksgiving, and Christmas. Ordinary weekends and early closes are not holidays.
The [2018 Bush](https://ir.theice.com/press/news-details/2018/New-York-Stock-Exchange-to-Honor-President-George-H-W-Bush/default.aspx)
and [2025 Carter](https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx)
closures affect session ordinals only. Both were publicly announced before the entry of any trade whose ordinal
would change. The calendar extends beyond the price cutoff for known holidays and month boundaries.

### FOMC schedule

The [hardcoded statement dates](../../../../services/bayn/tools/research/event-calendar-etf-calendar.ts) are the
last days of the following Fed advance schedules, cross-checked against the
[FOMC calendars](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) and
[historical meeting archive](https://www.federalreserve.gov/monetarypolicy/fomc_historical.htm). The Fed moved
all scheduled statements to [14:00 ET in 2013](https://www.federalreserve.gov/newsevents/pressreleases/monetary20130313a.htm).
Do not include unscheduled actions, minutes, or notation votes. Keep the original 2020-03-18 date in the
schedule receipt but do not trade it. The March 15 replacement was publicly announced
[before either March 17 entry](https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20200315.pdf),
and the [2020 Fed archive](https://www.federalreserve.gov/monetarypolicy/fomchistorical2020.htm) records the cancellation.
The December 2026 date is registered but unpriced.

| Statement year | Federal Reserve advance announcement                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| 2016           | [May 2015](https://www.federalreserve.gov/newsevents/pressreleases/monetary20150511a.htm)    |
| 2017           | [June 2016](https://www.federalreserve.gov/newsevents/pressreleases/monetary20160628a.htm)   |
| 2018           | [May 2017](https://www.federalreserve.gov/newsevents/pressreleases/monetary20170511b.htm)    |
| 2019           | [May 2018](https://www.federalreserve.gov/newsevents/pressreleases/monetary20180525a.htm)    |
| 2020           | [May 2019](https://www.federalreserve.gov/newsevents/pressreleases/monetary20190517a.htm)    |
| 2021           | [July 2020](https://www.federalreserve.gov/newsevents/pressreleases/monetary20200702a.htm)   |
| 2022           | [June 2021](https://www.federalreserve.gov/newsevents/pressreleases/monetary20210604a.htm)   |
| 2023           | [June 2022](https://www.federalreserve.gov/newsevents/pressreleases/monetary20220624a.htm)   |
| 2024           | [June 2023](https://www.federalreserve.gov/newsevents/pressreleases/monetary20230623a.htm)   |
| 2025–26        | [August 2024](https://www.federalreserve.gov/newsevents/pressreleases/monetary20240809a.htm) |

## Registry and execution

Each of the first six rules runs independently in `SPY`, `QQQ`, `TLT`, `GLD`, and `IWM`. H4 is one
preselected portfolio. There are **31 trials, 124 trial-cost evaluations, and one promotable candidate**.
The windows using any open-to-close risk are diagnostics only.

| Rule              | Fixed entry and exit                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 overnight      | Enter the prior close, exit at the open of each exit session in `[T−1,T+3]`, inclusive. `T` is the last session of the month.                                                                                                                                                                                     |
| H1 close-to-close | Same exit-date selector, hold continuously through each contiguous block of selected closes. Mark daily and exit at the last selected close, or the registered tape cutoff if the block is truncated there.                                                                                                       |
| H2 overnight      | Enter the close before a scheduled statement session and exit at that session's open. This is the overnight portion of the pre-statement window.                                                                                                                                                                  |
| H2 24h            | Enter on the opening print proxy of the previous day's 14:00 5-minute bucket. Mark at that day's final regular 5-minute close. Exit using the close of the 13:55 bucket on statement day (not the 14:00 bucket, which can include the announcement). These are bar proxies for the nominal 14:00-to-14:00 window. |
| H3 overnight      | Enter the close before the final trading session ahead of a market holiday; exit at the final session's open.                                                                                                                                                                                                     |
| H3 open-to-close  | Enter at the open of that final session, and exit at its regular close, including shortened sessions.                                                                                                                                                                                                             |
| H4 composite      | Union of H1/H2/H3 **overnight** flags, without stacking coincident events. Equal funded weights across the five ETFs, scaled as below. Flat at every regular session open and no new entry until a regular close.                                                                                                 |

H4 takes no exposure until it has 60 complete historical overnight returns. Use the last 60 hypothetical
equal-weight basket overnight returns ending at or before **the day before the entry session**, including ordinary
non-event sessions. Compute sample volatility times √252 and scale to an 8% annualized target for the exposed
basket, capped at 100% funded gross; hold no exposure if the volatility is zero. Withhold the entire basket if
the preceding 20 SPY close-to-close returns over the same lagged history exceed 25% annualized volatility.
No entry-close or exit prices affect eligibility or size. H1–H3 are not regime-tuned.

Model price marks with fractional adjusted shares, no leverage, and no interest on idle cash. Costs are **0, 2,
5, and 10 bp round trip** (half on the entry notional, half on the actual exit notional) plus a modeled 0.21 bp
sell fee at all costs. Entry allocations include their fees and cannot overspend cash. Overnight P&L and both
fees belong to the exit session; the entry occurs at the prior boundary. Mark the 24h and close-to-close
diagnostics daily so their returns are not moved to an unrelated calendar date. Count one trade per completed
ETF round trip, not per signal, fill, or portfolio date.

## Statistics and controls

- Compound net daily returns, with zero for genuinely flat sessions. CAGR uses elapsed calendar time;
  volatility, Sharpe, Sortino and one-way dollar turnover annualize at 252. Use zero cash hurdle, sample
  volatility, RMS downside, and positive peak-to-trough drawdown. Win rate and profit factor use completed
  ETF trades (including fees, scaled by modeled equity at entry); profit factor without losses is undefined.
  Breakeven is the nonnegative round-trip slippage that reduces full-period compounded net return to zero,
  with the sell fee still charged; it is undefined if return is already nonpositive at 0 bp.
- Reproduce frictionless SPY total return, standalone SHY-idle F4 (`F4-42-1-LQD-parity` from Wave 5C),
  standalone SHY-idle O1 (`ensemble/base/21/0.05` from Wave 5D), and Wave 9B B0 (QQQ+SMH intraday, daily
  fixed-$100k P&L divided by $100k). Verify the published F4, O1 and B0 split totals before using their replays.
  Hold their policy and native fee assumptions fixed at each matching round-trip slippage.
- Calculate Pearson correlations from matched daily returns, including idle days, on the full window and
  Holdout. Also separately measure minutes of positive intersection of each trial's holding intervals with
  regular-session hours. Returning at the open boundary does not overlap the regular session.
- Fit the expected maximum nonannualized null Sharpe by cost on Train+Validation using
  [DSR](https://doi.org/10.3905/jpm.2014.40.5.094) over **all 31 trials**, replacing undefined development
  Sharpe with zero for the cross-trial dispersion estimate. Score against that benchmark with the usual skew
  and kurtosis correction on Holdout; the full sample DSR is descriptive. Costs are fixed scenarios, not
  candidate selections. This adjusts for Wave 18C only, not the accumulated Bayn research program.
- Test a positive daily mean net return with the one-sided, mean-centered
  [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870): 10,000 circular resamples, mean
  block length 10, seed `0x18c2026`, and a plus-one correction. These are nominal p-values, not adjusted
  for the trial grid. Use paired resampling on daily return differences for incremental portfolio tests.
- Compare each of F4 alone, O1 alone, and equal F4+O1+B0 with a fixed 25% allocation to H4, reducing incumbents
  pro rata. Daily capital resets pay half the round-trip cost on gross sleeve transfers (no extra sell fee
  on transfers). These are separately funded portfolio diagnostics, not simulated shared-account fills,
  netting, buying power, or collision avoidance with overnight positions in F4/O1.

## Decision

At **each** of 2, 5, and 10 bp round-trip slippage, H4 must satisfy all gates on unrounded results:

1. Full and Holdout net Sharpe at least 0.75; Holdout DSR at least 0.95 and stationary p < 0.05.
2. Positive net return in every fixed split and in at least seven of the ten 2016–2025 calendar-year buckets.
3. Zero minutes of regular-session exposure; absolute Pearson correlation below 0.25 to each of SPY, F4,
   O1, and B0 in both the full sample and Holdout. Undefined evidence fails.
4. Improved full and Holdout Sharpe in all three 25% allocation comparisons, positive Holdout compounded
   return lift, and paired Holdout incremental-mean p < 0.05 in each comparison.

Failure of any gate gives **DO NOT PROMOTE**; diagnostic outcomes cannot replace H4. Any statistical pass
would only merit consideration in a new prospective study, never deployment, broker, or capital authority.
