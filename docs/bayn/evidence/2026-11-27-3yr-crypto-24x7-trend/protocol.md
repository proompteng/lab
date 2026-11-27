# Wave 2E preregistration: 24/7 Alpaca spot trend and momentum

**Scope:** research only. No broker, execution authority, live-policy hash, migrations, or paper/live changes.
The hypothesis is that slow, cash-backed long/flat crypto trend can survive two 25 bp taker legs and still
improve risk-adjusted outcomes relative to passive crypto exposure. Failure is a valid result; there is no
post-holdout parameter change or promotion of a higher-scoring shadow row.

## Inputs and fences

Use the two S3 objects in `bayn-research-datasets/2026-11-27-crypto-3yr/MANIFEST.json`: 248,820 1H and 16,772
daily UTC bars for BTC, ETH, SOL, LINK, AVAX, LTC, DOGE, AAVE, UNI and XRP against USD. Verify manifest schema,
universe, object paths, raw and compressed sizes and SHA-256 digests, exact row counts, aligned timestamps,
numeric OHLCV and uniqueness within the scored windows. Both source objects include one row per coin at the
exclusive 2026-11-27 00:00 UTC boundary. Verify and count these ten rows per object, but never decode
their prices or score them. Bind the exact manifest and file digests to the receipt.

| Frame | Train (inclusive)       | Validation (inclusive)  | Frozen Holdout (inclusive) |
| ----- | ----------------------- | ----------------------- | -------------------------- |
| 1H    | 2024-01-01 – 2025-06-30 | 2025-07-01 – 2026-03-31 | 2026-04-01 – 2026-11-26    |
| 1D    | 2022-01-01 – 2024-06-30 | 2024-07-01 – 2025-08-31 | 2025-09-01 – 2026-11-26    |

Develop with `--freeze`, which verifies whole-object bytes but neither decodes holdout prices nor simulates
holdout bars. Commit the protocol/code before freezing, then commit the development-only receipt as a separate
commit before `--score`. Scoring checks the receipt against the commit that added it and independently reproduces
the exact development receipt before loading holdout prices. A score run cannot rewrite either file. Use
`--score --output <new-path>` for independent reproduction.

Signals use only the latest completed bar and earlier prices. Execute at the following bar's recorded open, never
on the signal bar or using its subsequent high/low to assume intrabar fills. Every split starts in cash with
fresh position state; indicators may warm up on preceding data. Each split liquidates at its pre-scheduled
terminal close, and pays the exit fee. Report calendar years by chaining split returns (no extra calendar-year
liquidations), plus fixed **2022 bear**, **2024 bull**, and **2026 Q1 pullback** windows. An unavailable frame/year
is not backfilled from a different timeframe. Partial 2026 ends on November 26 UTC.

Do not compress the time axis across gaps. Broken lookbacks are unavailable until enough contiguous completed bars
are present. An unpriced open cannot execute a trade. Existing holdings are marked at the last real price until
a new bar arrives; record stale exposure and any unliquidated terminal positions. This includes quote-only Alpaca
bars when present; open and close are price proxies, not evidence of executable liquidity. No leverage, shorting,
cash yield, spreads, slippage, adverse selection, quantity rounding, minimum order or fill probability are modeled.
Use sell-then-buy self-financing accounting, scale purchases to remaining cash including fees, and never trade a
negative position. These are research bounds, not net live-execution forecasts.

## Fixed trial registry

Horizons in hours map to daily bars with ceiling division by 24. Use 365 UTC days per year. Volatility is trailing
sample standard deviation of log returns (annualized at the bar frequency); sizing volatility uses 20 days.
EMA starts at the first full consecutive window's arithmetic mean and resets after a gap. ATR is the 48-hour
rolling mean of true range with the preceding close available.

1. **Multi-horizon time-series trend, 10 coins.** Donchian breakout above the preceding 24/72/168/336-hour high
   and exit below the paired 12/36/72/168-hour low. Cross these pairs with channel-only, or channel plus
   a 2.5×/4× ATR trailing exit, tested at the completed close against the high watermark since entry.
   Separately test EMA pairs 24/120h, 48/240h, 5/20d, 10/40d. Go long while fast is above slow. Cross all with
   15%, 20%, 25% annual target risk. Each active slot receives target / (10 × coin vol), capped at 1/10.
2. **Cross-sectional dual momentum, 10 coins.** Rank the 7/14/21/30-day log return divided by the same
   window's annualized volatility; ties fall to manifest order. Keep only the top 2/3 that pass the
   selected absolute gate (close above trailing 20-day SMA, or positive ranking-window return). Put 1/K
   of NAV in each passing slot; unfilled slots stay in USD. Rebalance every 3/7 days or at split start;
   nonzero-to-nonzero changes smaller than 10 percentage points of NAV are skipped. Missing evidence
   cancels the desired holding until the next scheduled rank; exits are never banded.
3. **Risk-parity trend, 3 vs 10 coins on both frames.** EMA trend pairs 5/20, 10/40, 20/100 and 40/200 days;
   cross 15%, 20%, 25% with/without the same EMA gate on BTC. Use equal volatility budgets over the fixed
   roster: target / (roster size × coin vol), with inactive shares left in USD and scaling to 100% gross if
   necessary. This uses a perfect-comovement sizing approximation, not estimated covariance risk parity.
   Resize weekly while signals remain on. BTC/ETH/SOL is the legacy Bayn crypto roster, not current entry authority.
4. **Compression / weekend breakout, 1H only, 3 vs 10 coins.** Enter at the close-confirmed 24/72/168-hour
   breakout if prior-completed 24h vol is below 0.60/0.80 of same-as-of 168h vol, with all-days entries or
   Sat/Sun UTC only. Exit on the paired channel or 3× ATR trailing stop; require 24h cooldown after exit.
   Size as the first family at 20%, divided across the configured roster.

Families 1, 3 and 4 take signal entries/exits without waiting for resizing. Unchanged positive targets can
resize only every 3, 7, or 3 days respectively, for drift of at least 20% of target dollars. Cadences are anchored
to midnight UTC on Monday 1970-01-05; all prices and weekends are UTC. The exact axes and identifiers live in
[`research-crypto-trend-protocol.ts`](../../../../services/bayn/tools/research-crypto-trend-protocol.ts).

The research rationale comes from [Liu & Tsyvinski (RFS)](https://doi.org/10.1093/rfs/hhaa113),
[Moskowitz, Ooi & Pedersen (JFE)](https://doi.org/10.1016/j.jfineco.2011.11.003), and
[Liu, Tsyvinski & Wu (JF)](https://doi.org/10.1111/jofi.13119). These are motivating hypotheses, not duplicate
specifications or evidence of profitability on Alpaca.

## Friction, controls, and acceptance

Charge **25, 15 and 10 bp per side** for **50/30/20 bp round trips**, on both buys and sells; all three tariffs
get independently cash-funded portfolios. The gate is **50 bp RT**. Alpaca's
[fee schedule](https://docs.alpaca.markets/us/docs/crypto-fees) confirms Tier 1 taker (25 bp) and maker (15 bp)
and lists **10 bp maker as Tier 3**, not Tier 4 (8 bp). The requested 20 bp numerical sensitivity is unchanged.
Maker fees model fee rate only, not guaranteed passive fills. [Alpaca spot](https://docs.alpaca.markets/us/docs/crypto-trading-1)
is non-marginable and non-shortable. The user-supplied prior Bayn taker loss of $5,374 motivates the turnover
limit; it is not used in the calculations.

Benchmarks use fee-matched BTC/USD buy-and-hold and a buy-and-hold basket initialized with ten equal USD sleeves.
Each basket sleeve stays in cash until the coin first has a recorded open within the split; it is then bought once
and not rebalanced. Both benchmarks pay the same exit fee. Report compounded net return, CAGR, annualized daily
Sharpe (zero cash rate, sample SD), peak-to-trough drawdown from the sequential open/post-trade/close NAV marks,
drawdown divided by matched BTC drawdown, Calmar (CAGR / max drawdown), and compounded return excluding five
largest UTC daily net returns. Turnover is bought plus sold notional as a fraction of pre-trade NAV, annualized
by calendar days, and annual fee drag is that rate times side fee. Report coverage/stale exposure separately.

Use a one-sided circular moving-block bootstrap, 7 UTC days, 10,000 resamples, deterministic xorshift32 shared
starts by window length, mean-centered daily net log returns and add-one p-value. The null is no positive log
growth, not alpha over BTC. Use the [Deflated Sharpe Ratio](https://ssrn.com/abstract=2460551) with per-frame,
per-fee Train cross-trial daily-Sharpe dispersion, the full frame grid trial count (no discount for correlation),
and each period's sample skew/kurtosis. DSR is a diagnostic, not independent evidence under serial dependence.
LOCO reruns every trial with each member excluded in turn, reranking, rebuilding budgets for the smaller roster
and using ETH as the market gate when BTC is omitted. Compare all three fees and splits; LOCO is diagnostic,
not a quorum gate.

At 50 bp, require each split to have **net > 0**, **ex-top-5 net > 0**, **max DD < half BTC**, annual gross
turnover **≤24×** NAV (≤12 whole-NAV round trips/year), nonzero exposure, **≤0.5%** stale held coin-bars, and
no terminal unsettled holdings. On each split require a plateau: at least two adjacent axis neighbors tested,
and at least half independently pass all the split economic gates and retain ≥70% of the candidate Sharpe.
Adjacency steps one level along exactly one registered axis without changing frame, universe, or rule kind.
On the fixed regimes covered by a frame require Sharpe higher than **both** benchmarks, max DD below half BTC,
and positive Calmar. Hourly candidates also require their exact registered daily pair to clear all split and
regime gates, including 2022. Hourly-only compression has no daily pair, so cannot earn full-cycle qualification.

Freeze **at most one nominee per frame and rule kind**, after the Train/Validation gates and all regime gates
observable in development, including the paired daily development check for 1H. Rank eligible trials by the
lesser of Train and Validation 50 bp Sharpe, then ID lexicographically. If none qualify, the top development
rank is a labeled diagnostic only. Score all rows once, without changing nominations or the protocol.
A nominee (and its daily comparator for a 1H nominee) must also pass the economic and plateau gates in
Frozen Holdout with one-sided p < 0.05 / number of nominees (Bonferroni; raw p-values also reported), and
pass any fixed regime gates not known at freeze. No shadow row or failed nominee becomes a strategy module.
