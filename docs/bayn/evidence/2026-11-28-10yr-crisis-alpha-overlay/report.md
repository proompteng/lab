# Wave 21M: 10-year crisis-alpha overlay

## Preregistered protocol

**Question.** Can a long-only, daily, next-open ETF sleeve meaningfully improve the worst-quarter and 2020/2022 drawdowns of B0 + F4 + O1 without giving up net CAGR or Sharpe? This is a historical research experiment, not a trading authorization.

### Evidence and allocation

- The overlay and SPY benchmark may use only the requested ETFs in the authenticated
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/` manifest and its daily adjusted SIP tape.
  Require SPY and QQQ plus at least one requested haven. UUP is absent from that manifest; exclude it without a
  proxy, even though it exists in a different object used by the unchanged macro references. Require an
  observed open and close for every admitted symbol on every registered session. Never forward-fill.
- The baseline uses the fixed Wave 9B B0 QQQ/SMH Noise Area signal and Wave 17-9's signed whole-share
  B0 sizing, and separate whole-share F4 and O1 books run by the Wave 8A account replay. Reuse the original
  QQQ/SMH five-minute SIP archives for B0 and the registered daily DIA/UUP companion for F4/O1 only. Check
  B0's fixed-size replay and the F4/O1 signal identities against their upstream receipts. Missing B0 entry
  prints are counted and do not fill. An unresolved exit aborts; a held-bar gap on a scored date blocks promotion.
- Run those references from the first archive session at $100k **each**, preserving their own capital caps,
  sizing and state. At the start of the scored period take normalized stakes of 40% B0, 35% F4, 25% O1.
  Aggregate their independently compounded marks without cross-account trades or rebalancing. This is a
  reference mix, not a replay of the published $40k/$35k/$25k account allocation with those starting balances.
  SPY is a passive adjusted-price benchmark, already held at the scoring boundary, with no mid-study trades.
- For each overlay arm replace 25% of the initial reference mix with a separately funded fractional ETF sleeve.
  The 75% reference stake stays intact; subsequent sleeve weights drift. This tests a funded capital replacement,
  not a levered add-on or live transfer. The equal SPY/QQQ static arm isolates the cost of substituting an equity
  sleeve for base capital. The cash control tests the same primary switch without purchasing havens.

### Rules and execution

- From completed closes only, calculate SPY's 200-session simple moving average and its 20-session sample
  standard deviation of close-to-close log returns, annualized by √252. A break is close strictly below the
  moving average; high realized volatility is at least 20%.
- The fixed **primary** goes defensive on **either** trigger. A diagnostic goes defensive only on **both**.
  In offense use equal SPY/QQQ. In defense use equal weights among admitted GLD, TLT, IEF, SHY and DBC whose
  own close is strictly above its 63-session simple moving average. If none qualifies, hold idle cash with
  zero credited interest. The cash control uses no havens; the static control always targets offense.
  No tuning, model fitting, fold-dependent winner selection, or alternative rules after scoring.
- Review after each completed close. Rebalance at the next recorded open only if required one-way replacement
  at the prior close is at least 10 percentage points (greater of target buys and sells, including implicit cash).
  Fund the sleeve in cash before its first scored open and use the same rule from inception. In-band positions
  retain exact shares. Old holdings receive the overnight gap, new holdings the open-to-close move. Size
  fractional targets on post-fee opening equity; no shorts, borrowing, intraday fills, or terminal liquidation.
- Stress **0 / 2 / 5 / 10 bp one-way**, consistently across the traded reference accounts and ETF sleeve,
  plus the existing 0.21 bp fee on sell proceeds at every tier. Zero means no modeled slippage, not no fees.
  Report realized overlay turnover as traded ETF notional divided by twice opening sleeve equity, annualized
  over 252 sessions. These are friction scenarios, not measured auction fills, spreads or market impact.

### OOS and decision

The calendar spans 2016-01-04 through 2026-11-25. Use 2016-01-04 through 2016-10-31 for initial history.
Score fixed rules continuously and report consecutive walk-forward folds, with only past state carried
into each later day: **2016-11-01–2019-12-31**, **2020-01-02–2021-12-31**, **2022-01-03–2023-12-29**,
**2024-01-02–2026-11-25**. OOS means decisions were out of sample with respect to their inputs,
not that this already-studied historical tape was blind or prospectively reserved.

- Report compounded net, calendar-time CAGR, annualized daily Sharpe (zero risk-free rate), and close-marked
  peak-to-trough MaxDD. Reset each reporting window's high-water mark to its opening equity (preceding close);
  do not reset holdings. Find worst compounded-return and worst MaxDD calendar quarters among complete
  quarters (exclude 2016 Q4 and 2026 Q4); also compare all books in the baseline's worst MaxDD quarter.
- Report 2020-02-19 through 2020-04-30 (COVID selloff and partial recovery) and 2022-01-03 through 2022-12-30
  (full bear year). These dates are retrospective labels, not signal inputs. Attribute the baseline's ten
  worst individual sessions and its worst contiguous ten-session window on the same dates for all arms.
  Within each crisis, break out ETF contributions and fees by the regime held after the open; overnight
  price moves always use the old inventory. Arithmetic daily contributions are not compounded excess.
- Pair realized primary/base daily returns in a circular stationary block bootstrap (2,000 draws, mean
  block 10 sessions, xorshift seed `0x21a2026`). For the stitched OOS period report central 95% percentile
  intervals for net CAGR and Sharpe differences and baseline-minus-primary MaxDD. The resampling measures
  sensitivity to clustered observed returns; it does not manufacture independent crisis episodes.
- **PROMOTE** only if the primary meets all of these at **both 5 and 10 bp**: no loss of net OOS CAGR or
  Sharpe, and at least **1 percentage point** lower MaxDD for its own worst complete quarter and for
  each crisis window. Also require a strictly positive 5 bp paired bootstrap lower bound for OOS MaxDD
  improvement and no scored B0 held-bar gaps. Otherwise **DO NOT PROMOTE**. The other arms are diagnostic
  and cannot rescue a failed primary. A pass would only warrant further prospective research.
