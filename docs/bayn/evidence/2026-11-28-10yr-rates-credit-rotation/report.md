# Wave 20D: 10-year rates and credit defensive rotation

## Preregistered protocol

**Question.** Can a fully funded daily ETF rotation earn positive net risk-adjusted returns above short Treasuries,
or improve the existing Bayn research portfolio's Sharpe, Calmar, and drawdown at a fixed capital weight?

### Data and walk-forward evaluation

- Admit only the frozen SIP total-return daily marks from `bayn-research-datasets/2026-11-27-sip-10yr-sp100/`
  for TLT, IEF, SHY, HYG, LQD, GLD and the SPY comparator. Admit TIP only from the existing Wave 13C local
  research input, staged from its pinned [SIP supplement](../2026-11-27-10yr-orthogonal-pillar3/README.md#inputs-and-development-freeze).
  All seven sleeve tickers require full session coverage. BIL and SGOV are excluded: neither is in the
  verified base manifest or the staged local inputs. SHY is a traded Treasury ETF, not a cash proxy with fabricated yield.
  The pinned DIA/UUP supplement and B0 5-minute tapes are comparator inputs only.
- Use the complete 2,741-session intersection: 2016-01-04 through 2026-11-25 (2026 is partial).
  The dates must match the pinned exchange calendar exactly. Use 2016–2021 as the reference/warm-up
  fold (1,511 sessions), 2022–2023 as forward fold 1 (501), and 2024–2026 as forward fold 2 (729).
  Also report both forward folds pooled, the full span and all calendar-year returns. Rules, parameters
  and weights are fixed, not fitted in either fold. Carry positions and history across boundaries,
  without resetting held assets or applying an end-of-sample liquidation.
- These are chronological out-of-sample (OOS) tests of fixed rules, not prospective or previously unseen market data.
  Other Bayn studies used these markets and dates. The bootstrap addresses serial dependence, not research-wide
  selection bias. No asset, year, or rule is removed based on performance.

### Registered rules and execution

1. **Stress switch (primary):** Each session after 126 prior sessions, give each of TLT, IEF, TIP, HYG,
   LQD and GLD a score equal to its mean 21/63/126-session close-to-close log return minus SHY's at the same horizons.
   Only positive scores are eligible. Allocate 50% each to at most two eligible assets; any unfilled slot goes to SHY.
   In stress, only IEF and GLD remain eligible. Stress means the 63-session HYG/IEF ratio fell or SPY lost at least
   5% over 21 sessions. Outside stress, TLT is eligible only when the 63-session TLT/IEF ratio rose.
   These are market-price proxies for credit and duration, not measured yield-curve slopes or option-adjusted spreads.
2. **Relative strength (ablation):** Same scores, ranks, weights and execution; no credit, equity or curve filters.
   This rule is diagnostic and cannot qualify for promotion.

An eligible incumbent receives a 50 bp ranking advantage (in blended log-return units); remaining exact ties
use the registered order above. A rebalance requires at least 10 percentage points of buys or sells in aggregate
against actual prior-close weights. A falling score that becomes ineligible loses the ranking advantage.
Initialize in SHY at the first open and remain there through warm-up. Decisions use only completed closes
through session **t**; fill at the next exchange-session open. Old shares take the overnight gap; new shares
earn only after their fill. There is no close fill on the signal date or same-day open-price trigger.

Replay fractional, long-only shares at adjusted marks; no leverage, shorts, injected yield or fabricated quotes.
Stress **0, 2, 5 and 10 bp round-trip** by charging half the quoted bps on each buy or sell, plus the existing
0.21 bp sell fee for comparability to F4/O1/B0. Thus 0 bp RT is zero spread/slippage, not zero statutory cost.
Pay entry friction on SPY and SHY; do not charge an unexecuted liquidation. Costs for existing sleeves use
their original replay conventions.

### Controls, portfolio construction and metrics

- Audit [F4](../2026-11-27-10yr-vol-regime-carry/README.md) as the fixed Wave 5C SHY-idle
  `F4-42-1-LQD-parity` replay, and [O1](../2026-11-27-10yr-pure-etf-dual-horizon/README.md) as the Wave 4D
  base ensemble with SHY sweep. Reproduce F4's 10 bp RT published folds and full period and O1's 2/5/10 bp
  RT published full-period returns.
- Audit [B0](../2026-11-27-10yr-qqq-smh-conditioning/README.md) as the Wave 6A QQQ/SMH
  `B0/30/1.4/opposite_band/inverse_vol_parity` control using original fixed $100,000 sizing and zero return
  on idle cash. Reproduce the 2/5 bp RT published net P&L by fold and overall; require no unresolved exits,
  no missing entries and exactly the one documented skipped held bar. For blended and comparable
  compounded metrics, use each day's P&L divided by $100,000, not the original fixed-dollar wealth curve.
- Build a primary equal-weight F4/O1/B0 portfolio and a secondary equal-weight SPY/F4/O1/B0 portfolio.
  For each and for each individual SPY/F4/O1/B0 leg, replace 25% of the base's capital with the candidate,
  funding it proportionally from the base. Compare to the exact same base without the sleeve.
  Stacks reset weights daily at the prior close and pay half the RT bps on gross capital transfers.
  They include the component trading costs, with no cross-sleeve netting, buying-power offsets or
  inferred shared fills. This is a historical allocation diagnostic, not a joint order simulator.
- All portfolio paths are matched close-to-close (first session begins at its open). Compound NAV; use elapsed
  calendar years for CAGR, daily sample volatility scaled by √252, zero-risk-free-rate Sharpe, zero-target
  Sortino, and Calmar = CAGR/MaxDD. MaxDD is the positive peak-to-trough loss, including starting capital
  as a potential peak. One-way turnover is half the absolute traded notional over NAV, annualized at 252
  sessions; for B0 use its cost slope to infer turnover, and include transfers in blend turnover.
  Report the standalone sleeve's daily Pearson correlation with each unmodified base.
- Use the shared circular stationary block bootstrap with 10,000 draws, mean block length 10 sessions and
  seed `0x20d5a11`. Use identical draws within each matched comparison, a one-sided centered mean test on
  daily sleeve-minus-SHY return, and a one-sided 97.5% basic lower bound on paired Sharpe lift (not the Sharpe
  of the excess series). Score both forward folds, the pooled OOS period and the full span (descriptive).
  Null means undefined or not tested.

### Promotion gates

At every registered cost the **primary rule** must pass the same route. The two confirmatory routes each
use one-sided 2.5% inference; the ablation, alternative bases and full-period results are descriptive.

- **Standalone:** Positive CAGR and Sharpe and positive compounded return difference versus SHY in
  both forward folds, plus pooled OOS mean-excess bootstrap p < 0.025.
- **Portfolio:** At the fixed 25% allocation in the F4/O1/B0 blend, improve Sharpe and Calmar, reduce
  MaxDD, and have absolute sleeve–base correlation below 0.50 in both forward folds; the pooled OOS
  lower bound on Sharpe lift must exceed zero.

If neither route passes, report **DO NOT PROMOTE**. A pass would justify further research, not deployment or
permission to trade. Adjusted daily SIP opens do not prove executable prices, market impact, or live capacity.
