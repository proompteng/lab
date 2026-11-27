# Wave 1F frozen comparison protocol

This is an offline sizing study. It has no broker authority and does not select a production policy.

- Compare v2 signal selection and weights with volatility scaling, dispersion scaling, inverse-volatility, equal risk
  contribution (ERC), combined sizing, and combined sizing with the loss throttle, profit lock, or a lower concurrent
  cap. Keep signals, timing, replay economics, and market eligibility identical between comparison arms.
- Use 2/5/10 bp round-trip consolidated NBBO scenarios plus a 0.21 bp fee on sell notional. IEX quotes are not
  execution-cost evidence. Use v2 completed-close entry collars and the first open inside the one-minute working
  window strictly after v2's delayed observation, not eventual intrabar touches. Record unfilled legs, partial baskets,
  and missing execution evidence. An unavailable entry open or held bar makes the entire account path and its
  shadow returns unknown; no later trade is admitted on that path.
- Use lagged 14-session returns of the static shadow sleeves, expressed per baseline sleeve budget, for all adaptive
  risk estimates. Fit target volatility from median trailing volatility in development only. The dispersion ratio
  uses eligible equity VWAP deviations on the decision bar and its own checkpoint's lagged 14-session median.
- Separate July–August warmup and three successive 22-session live-universe folds. In each fold, freeze selection and
  volatility targets using strictly earlier observations; also report every prespecified arm on every forward fold.
  Select on 5 and 10 bp development results: require positive ex-five net at both, then maximize the worse average
  rank across Sharpe and Calmar at those costs, breaking ties by grid order. Retain static if no arm qualifies.
  For the 2024–26 check, use only AAPL/AMZN/NVDA and QQQ/SMH with SPY as benchmark; no historical Midday or backfilled
  equities. Use the manifest's development/validation/holdout partitions and splice the live file at August 25.
- Start each session at a fixed $100k for comparable sizing. Gate new gross at $180k or 4× marked equity, whichever is
  lower; reserve both sides with no netting of gross. Keep $40k order/symbol limits and $100k worst-case directional net
  admission limit. Record drift separately from admission. Do not force liquidation merely because marks drift.
  The afternoon overlays apply only to new entries at or after minute 120; compare a latched 1.5% drawdown throttle
  and a latched 1.5% gain / 0.5% giveback profit lock. Both halve new size when triggered.
- Publish all results, including three folds, regime splits, worst/best five removals, leave-one-symbol-out (rerank,
  refit, and replay, not subtraction), block bootstrap and Deflated Sharpe. Stress nearby combined targets and
  dispersion slopes (±10%). Regime labels are diagnostics, not trading inputs.
- A promotion candidate needs, at **both 5 and 10 bp**: positive net and ex-top-five net, all live folds positive,
  Sharpe and Calmar strictly better than the static control without lower net, bootstrap p ≤ .05, DSR ≥ .95,
  positive ex-five net in every LOSO and every adjacent parameter configuration (for combined candidates), positive
  net in all four regime slices, no unresolved outcomes or gross breaches, and positive net and ex-five net in the
  long-history validation and holdout for the corresponding two-sleeve variant. A result that cannot be evaluated
  fails the gate. These are screening gates, not proof of future returns.
