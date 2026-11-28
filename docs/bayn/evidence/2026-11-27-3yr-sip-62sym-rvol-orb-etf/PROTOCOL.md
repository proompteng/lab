# Wave 2D preregistration: SIP intraday momentum

This is a retrospective bar-model study with no live strategy, migration, order, or capital authority. It uses the
manifest's Alpaca split-adjusted SIP aggregate volume, not IEX volume or observed NBBO quotes. The supplied manifest
contains 46 named stocks and 16 ETFs (62 total), not 50 separate stocks plus 16 ETFs; no other names or substitute feed
are enrolled. All three calendar years are represented through the requested November 25 cutoff, not through year-end.

## Input and chronology

- Authenticate the S3 manifest, exchange calendar, compressed bytes, decompressed bytes, and row count by pinned
  hashes/lengths. Vendor start timestamps are UTC; use the official New York regular calendar, including early closes
  and daylight saving time. Discard outside-session rows rather than relabeling them. A missing slot is not a zero-volume
  bar. Do not synthesize bars.
- Train: 2024-01-02 through 2025-06-30. Validation: 2025-07-01 through 2026-03-31. Frozen Holdout:
  2026-04-01 through 2026-11-25. Publish calendar half-years 2024H1 through 2026H2 separately (2026H1 contains both
  Validation and Holdout; 2026H2 is partial). Score no Holdout OHLCV until the development receipt is committed.
  Score requires a Git-committed receipt, recomputes it using only development rows, and verifies the source and artifact fingerprints.
- All 46 stock identities and 16 ETF identities are fixed throughout. For ALAB use the March 20, 2024 IPO; for GEV,
  the April 2, 2024 regular listing; for SNDK use regular-way Nasdaq trading starting February 24, 2025, not the
  when-issued rows in the archive. WDC resets its prior-session history at that distribution boundary; split
  adjustment is not a spin-off total-return adjustment. Do not bridge an incomplete prior session.
- Every traded symbol requires 14 strictly prior calendar sessions with the required observations. ATR is the
  arithmetic mean of prior 14 regular-session true ranges; each needs all its 5m slots and previous session close.
  The first observed session of an identity starts with its high–low, including WDC after reset. OR volume requires
  14 complete same-width ranges, excluding the current session. ETF noise requires 14 same-checkpoint moves, with
  the opening bar and checkpoint close present; an early-close session can contribute only checkpoints it reached.

## Frozen trial grid and execution

1. **ORB (2,016 configurations).** Cross OR5 and OR15 with RVOL 1.5/2/2.5/3, K=1/3/5, none/gap/SPY, ATR stops
   0.10/0.15/0.20/0.25/0.30/0.35 and opposite opening-range edge, and targets 2R/5R/10R/no target. Direction is
   the sign of the range close minus its open; exclude dojis. Gap is absolute first open minus last RTH close,
   at least 0.5 ATR. SPY alignment uses the sign at the same completed opening range. Rank eligible symbols at
   range completion by descending RVOL with symbol tie-break; freeze the top K for the session, with no replacement
   after a missed breakout or exit. The first _subsequent completed_ bar whose high (long) or low (short) strictly
   breaks the range triggers a next-slot open entry. The paper's live resting breakout entry and stock-wide price/
   liquidity screen are not replicated. The paper's 0.10 ATR stop and EOD exit are registered alongside the
   separate opposite-range-edge stop and target variants. Divide a 1% equity risk budget by K and per-share stop
   distance; for the range stop use the signal close as the sizing reference and reject an open already beyond it.
2. **Noise Area / cross-asset trend (36 configurations).** Cross QQQ+SMH, fixed six equity ETFs
   (QQQ, SMH, XLE, XLF, XLI, XLV), and all 16 (including rates and commodities) with 30/60 minutes from session open,
   multipliers 0.8/1/1.2, and entry ±1.5 daily ATR static stop vs true opposite-band checkpoint exit. At each
   checkpoint estimate the mean absolute return from each prior session's open to that checkpoint close. Today's
   upper band is max(open, prior close) × (1 + multiplier × mean absolute return); the lower band is min(open,
   prior close) × (1 − multiplier × mean absolute return). Enter on the first checkpoint close strictly outside the
   band, long above or short below. Opposite-band exits are checked only at the same scheduled checkpoints and
   filled at the next open; no intraday reversal or re-entry. This is independent time-series trend per ETF (not
   cross-sectional ranks). Split a 1.5% equity one-ATR move budget evenly across enrolled symbols and size inversely
   to ATR in shares. Inactive slots stay in cash.
3. **Combined (3 configurations).** Freeze the two Train-selected sleeves before Holdout, with 25/50/75% ORB
   capital and the balance in ETFs. Only 50/50 is a candidate; other weights are plateau sensitivities. Replay
   whole-share sizing at the partial budgets, not an average of already-rounded sleeve returns. Report Pearson
   correlation on paired complete daily sleeve net for each window and friction scenario.

All variants fix equity at $100,000 and reserve at most $180,000 gross entry notional (no compounding). Per-leg cap
is the smaller of $60,000 or sleeve gross divided by reserved slots, both scaled by sleeve allocation. Compute
whole shares from the risk budget and signal-price cap; also clip shares at the fill open to honor the dollar
reservation at the worst modeled entry slippage. The gross limit applies at entry, not as a continuous
mark-to-market rebalance. Prices are bar-open proxies, not executable quotes or contemporaneously archived
first-arrival bars. Model 2/5/10 bp round-trip slippage as half on each side, and 0.21 bp on actual sell notional
(short entry or long exit). Stops can slip through the threshold on adverse opens; favorable target gaps receive
only the threshold. If both stop and target are touched after the bar open, the stop wins. Flatten at the open
five minutes before official close (15:55 normally, 12:55 on half days), with no new entry there. A missing scheduled
entry bar is an unknown outcome, with no deferred entry. A gap while holding makes the leg unresolved; do not assume
the stop survived the gap. Any such committed missing path makes the affected window's net and inference unknown;
retain the sum of supported closed legs separately. Borrow, market impact, partial fills, queue, latency, live buying
power, and availability of point-in-time short locates are not established. The selected modern liquid stock cohort is
not a survivorship-free historical market screen.

## Selection, inference and promotion

- Rank by highest unannualized 10 bp Train Sharpe (ascending ID for ties). Freeze one candidate per sleeve,
  choosing only among Train gate passers; if none pass, freeze the highest-ranked complete Sharpe as a diagnostic
  and never promote it. Validation can veto but cannot replace. The balanced combination is fixed rather than selected
  on Validation or Holdout. Publish every registered trial and do not promote an exploratory Holdout standout.
- Each of Train, Validation and Holdout must be positive net **and** positive after removing the best five positive
  days at both 5 and 10 bp, with a one-sided circular block-bootstrap p < 0.05 at each cost. At least five of the same
  six half-years must have positive net at both costs. Separately test the stronger all-six Ex-Top-5 condition for
  each all-16 ETF variant. Do not change the gate to use 2 bp results. Report Ex-Top-10 as a sensitivity.
- The plateau gate at both costs in each of Train, Validation and Holdout requires at least two immediate
  one-axis neighbors, with at least 75% (rounded up) positive net and Ex-Top-5 at least 50% of the center's
  Ex-Top-5. Use adjacent levels for ordered axes (targets 2R, 5R, 10R, EOD; range-stop vs ATR has no ordered
  neighbor); changes between none/gap/SPY or between ETF exit types are categorical. For the balanced combination,
  test the two adjacent weights.
- Report circular bootstrap on each complete trial/window/cost: 10,000 seeded repetitions of five-session blocks
  of mean-centered net (truncate the last block to length), +1 correction to the upper-tail count. Unknown
  days make full-window inference unavailable. Annualized Sharpe uses 252 sessions. DSR uses Train 10 bp daily
  Sharpe dispersion of all nondegenerate registered variants and the full Wave 2D trial count; it is diagnostic,
  not an independence claim or an additional promotion gate. Prior research includes overlapping dates; no
  prospective out-of-sample claim follows from the chronological freeze.
- LOSO reruns the fixed ranking with each stock excluded (next in the ranking replaces a removed selection; SPY
  remains a benchmark), or removes one ETF with its slot left in cash. Preserve original size and reserve limits.
  Publish worst known omission and counts of known/positive omissions for every cost/window/trial and per-name
  results for the three frozen evaluations. An unknown omission is not counted as positive.

Sources: [Zarattini, Barbon & Aziz ORB paper](https://alexandria.unisg.ch/server/api/core/bitstreams/3c2989c4-688d-4d78-8a71-f02690990d51/content),
[Zarattini, Aziz & Barbon Noise Area paper](https://concretumgroup.com/wp-content/uploads/2026/02/Beat-the-Market.pdf),
[Alpaca bar timestamps and SIP](https://docs.alpaca.markets/us/docs/market-data-faq),
[Astera Labs IPO notice](https://ir.asteralabs.com/news-releases/news-release-details/astera-labs-announces-pricing-initial-public-offering),
[Nasdaq distribution notice](https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2025-38), and
[GE Vernova regular listing](https://www.gevernova.com/news/press-releases/ge-vernova-completes-spin-off-begins-trading-new-york-stock-exchange).
