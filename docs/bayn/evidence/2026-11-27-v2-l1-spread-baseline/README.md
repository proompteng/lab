# Bayn v2 frozen IEX L1 spread baseline — November 27, 2026

**UNQUALIFIED.** This is an event-time replay of 66 exchange sessions from August 25 through November 25, 2026.
It is not broker P&L, a causal arrival replay, a holdout, or evidence to change policy or capital. The earlier
calendar dates are baseline context only; this run has no multi-year price history. No adjusted-daily supplement
was supplied; 63 evaluation dates are missing at least one candidate baseline.

## Results

| Scenario                   | Supported closed legs | Modeled closed-leg subtotal | Ex-top-five subtotal | Unavailable sessions | Unresolved exits | Four-leg baskets filled / intended |
| -------------------------- | --------------------: | --------------------------: | -------------------: | -------------------: | ---------------: | ---------------------------------: |
| Synthetic 2 bp round trip  |                   300 |                 +$10,271.44 |           +$2,117.93 |                    1 |                0 |                            25 / 59 |
| Synthetic 5 bp round trip  |                   289 |                  +$7,071.90 |             −$839.14 |                    1 |                0 |                            18 / 59 |
| Synthetic 10 bp round trip |                   261 |                  +$3,710.54 |           −$3,998.13 |                    1 |                0 |                             8 / 59 |
| IEX minute L1 BBO          |                    91 |                  +$3,205.32 |           −$2,472.09 |                   46 |               66 |                             3 / 39 |

**Whole-window economics are unavailable in all four scenarios.** The L1 run retains 67 missing required quote
minutes across entry and exit paths. Missing exit prices are not replaced with synthetic spreads. The strict path
stops new planning after the first unavailable observation while retaining supported trades. L1 and synthetic
subtotals are therefore not estimates on a matched set of complete paths; their difference is not an estimate of
the incremental spread cost.

In each synthetic scenario, the first unavailable co-held mark is **QQQ at 2026-11-17 16:30:00 UTC** at the Midday
decision observed at **16:31:02 UTC**. The prior bar is one minute old. The separate diagnostic rerun, which carries
only the last earlier co-held mark up to two minutes and leaves entries and exits unchanged as pricing rules,
increases the synthetic 5 bp supported subtotal on November 17 by $542.71. Carrying that mark does not restore the
L1 session: another required observation is unavailable. No carry-forward values feed the strict results.

The L1 closed-leg subtotal is concentrated: removing the five largest daily subtotals changes +$3,205.32 to
−$2,472.09; the three in-order, equal-length subtotals are −$724.44, +$1,240.85 and +$2,688.90. The L1
mean absolute signed entry exposure among incomplete intended four-leg baskets is $15,987.70. The
[JSON report](results.json) includes portfolio and engine scorecards, the seed and block test, chronological fold
dates, reselected LOSO outcomes, session totals, and individual gap timestamps.

Every scorecard is **DIAGNOSTIC_ONLY_NON_QUALIFYING**. Its daily inputs are supported closed-leg subtotals,
not complete returns; no closed legs on an unavailable day contribute no measured P&L, not evidence of a flat day.
Sharpe uses sample daily variance and 252 sessions/year; Calmar is the annualized growth rate of the $100,000
starting equity plus cumulative P&L, divided by peak-to-trough equity drawdown. Profit factor uses net closed legs. The p-value is the one-sided
tail of 10,000 draws of five consecutive circular session blocks, sampled from the centered subtotal series.
The L1 portfolio value (0.132) is descriptive, not a test of a fully observed deployable strategy. Neither
chronological slicing nor LOSO converts retrospective model selection into independent validation.

## Inputs and reproduction

Objects were retrieved from bucket `agents-artifacts`, prefix `bayn-research-datasets/2026-11-27/`.
Object SHA-256 values are below; the report also records the uncompressed TSV digests and the normalized
calendar hash. The provider envelope has regular-hours fields only, including early closes.

| Frozen object                                | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `bars_1m_live_20260716_20261125.tsv.gz`      | `e61c56a9423156eedd6ae066e6428c0fb5a9b863a5b51c84ae97d5c962d16252` |
| `quotes_1m_spreads_20260824_20261125.tsv.gz` | `cd5dc8e80c54b3108887b912482718c00ffb9a0218bf8efe53fa6027b450263e` |
| `calendar_2024_2026.json`                    | `b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71` |

From the input directory after decompressing the TSVs:

```sh
bun /path/to/lab/services/bayn/tools/verify-intraday-alpha-replay.ts \
  --calendar calendar_2024_2026.json \
  --evaluation-start 2026-08-25 --evaluation-end 2026-11-25 \
  --quotes quotes_1m_spreads_20260824_20261125.tsv \
  bars_1m_live_20260716_20261125.tsv > replay.json
```

The committed JSON retains the CLI summaries, diagnostics and midday baskets. It condenses full per-session
attempt/trade records to daily counts and closed-leg subtotals by engine; rerun the command for individual trades.

The L1 model uses the last BBO from the completed minute as the decision quote, then the first bid for an
executable sell or first ask for a buy in the modeled fill minute. Intraminute stop-limit and target price proxies
apply the first observed half-spread ratio to trade-bar prices; there is no extra 2/5/10 bp charge in this mode.
The export does not identify quote timestamps, arrival lag, depth, short availability, or fill priority. Treat
first/last BBO as bucket proxies, not assertions of live ten-second quote eligibility. The assumed 0.21 bp charge
on sell notional remains a hypothetical fee, not a posted fee.
