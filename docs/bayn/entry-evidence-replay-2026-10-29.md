# Focused entry evidence replay

On October 29, 2026, an isolated six-call Jev study compared three retained crypto requests with a focused evidence
representation. Every pair used the same completed market bars, selected chart structures, funded proposal terms,
questions, criteria and 0.70/0.30 thresholds. The focused representation removed the duplicate benchmark history and
unrelated numerical state, stored each proposal once, and supplied exact source-price and chronology comparisons.
The calls had no execution authority and produced no orders.

| Retained case                               | Representation   | Breakout confirmation | Stop invalidation | Target obstruction | Selection |
| ------------------------------------------- | ---------------- | --------------------- | ----------------- | ------------------ | --------- |
| BTC, five consecutive closes above the base | Original replay  | 0.28                  | 0.66              | 0.30               | Rejected  |
| BTC, five consecutive closes above the base | Focused evidence | 0.84                  | 0.76              | 0.25               | Supported |
| BTC, one consecutive close above the base   | Original replay  | 0.53                  | 0.64              | 0.30               | Rejected  |
| BTC, one consecutive close above the base   | Focused evidence | 0.30                  | 0.72              | 0.24               | Rejected  |
| ETH, five consecutive closes above the base | Original replay  | 0.42                  | 0.64              | 0.35               | Rejected  |
| ETH, five consecutive closes above the base | Focused evidence | 0.82                  | 0.75              | 0.34               | Rejected  |

The original responses used 96,610 input tokens; focused responses used 47,761. All six calls returned HTTP 200 with
77 output tokens each. Dollar billing was not independently reconciled. These are three diagnostic cases, not an
accuracy benchmark, backtest, profitability estimate or natural trading proof. The original provider answers also
differed slightly from replay answers, so a single response is not a deterministic model oracle.

The implementation reproduced all three focused request bodies in native Linux verification, apart from the durable
state-version identifier. Its historical reader reproduced all five retained funded requests in the source sample
with their original request hashes. Current execution accepts protocol v32 only. The complete original numerical
source remains in the durable input; source freshness, accounting and all financial risk controls remain independent
of the focused Jev state.

TypeSafe recommends keeping arithmetic and date comparisons in code and removing irrelevant state from Jev inputs.
See [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) and
[state construction](https://docs.typesafe.ai/concepts/state). Computed comparisons do not establish that a selected
structure is meaningful. Jev retains that judgment, including the crypto resistance check.
