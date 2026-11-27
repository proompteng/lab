# Consolidated SIP follow-on

**No candidate advanced from development.** The new consolidated 21-symbol tape changed source coverage; it did not turn historical, partially observed outcomes into a new blind holdout. The [original Wave 1C results](README.md) are unchanged.

## A different information set

The [predeclared screen](sip-seasonality-protocol.md) tests cross-sectional continuation in the same exchange-local half-hour on preceding sessions, not the original same-day price rankings. The [ledger](sip-seasonality-development.json) records all 64 variants and Validation DSR using 328 total trials: the original 264 plus these 64. The screen uses 374 Train and 189 Validation dates and does not decode holdout prices.

|  Cost | Train rules with positive ex-top-five | Validation rules with positive ex-top-five |
| ----: | ------------------------------------: | -----------------------------------------: |
|  2 bp |                                  0/64 |                                       0/64 |
|  5 bp |                                  0/64 |                                       0/64 |
| 10 bp |                                  0/64 |                                       0/64 |

The least-negative **Validation** 5 bp ex-top-five variant was 14:30 ET, 20 prior sessions, two names at each tail, and a 20 bp predicted spread threshold. It returned **+9.10 bp** net across 49 traded dates, **−85.96 bp** ex-top-five, with bootstrap p = 0.4249. At 10 bp it returned **−112.72 bp** net and **−195.36 bp** ex-top-five. Neither the isolated raw profit nor the new tape justifies choosing the rule. No rule passed development, so none was selected, no holdout candidate score was generated, and no production module was added.

## Verify the export before replay

The checked-in tools enforce the manifest, calendar, compressed and uncompressed SHA-256 receipts. The export at `bayn-research-datasets/2026-11-27-sip-multiyear/` is split-adjusted; applying the legacy NVDA price adjustment again would corrupt the data. An independent exchange-calendar profile found **5,820,222** regular-session rows and **671,670** outside regular hours among 6,491,892 rows. In particular, the raw export includes an AAPL print at 08:30 ET on Jan 2, 2024 despite the filename saying RTH. The calendar, not the filename, cuts the regular session. The first SNDK regular-session records are dated Feb 13, 2025; there are no invented prices before then. All 21 symbols have observed opening and closing minute records on each of the 189 Validation and 166 Holdout dates, which does not imply every interior minute is present.

To reproduce the development screen, stage `MANIFEST.json` and `alpaca_sip_1m_rth_bayn21_20240102_20261125.tsv.gz` from that prefix and `calendar_2024_2026.json` from the original `2026-11-27/` prefix. Run:

```sh
bun services/bayn/tools/research-sleeve4-sip-seasonality.ts <staged-sip-directory> <new-development.json>
```

The output is exclusive-create. Do not commit the staged input objects.
