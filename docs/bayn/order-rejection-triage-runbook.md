# Bayn order rejection triage

Use this offline report to find where terminal equity entry attempts missed and estimate the price move those misses
left on the table or avoided. It reads one local JSON file and writes the report to stdout. It has no broker, database,
or network mode and grants no authority to trade, retry an order, or adjust a guard.

```sh
bun services/bayn/tools/analyze-order-rejections.ts --fixture /private/entry-attempts.json --format markdown
bun services/bayn/tools/analyze-order-rejections.ts --fixture /private/entry-attempts.json --format json
```

Markdown is the default. JSON is `bayn.order-rejection-report.v1`. Both formats include the overall results and each
observed symbol × Eastern time bucket × account tier. A cause row uses the same all-attempt denominator as its parent
row; an absent cause row means no observed misses for that cause in the supplied population.

## Prepare evidence

From an authorized, read-only export, reconcile every terminal entry attempt in the selected window, including full
fills and local pre-submit blocks. Use one row per attempt, not per broker activity, fill, or risk-check event. Do not
include protective orders, exits, or still-working orders. Assign unique, positive fixture-local integer `attemptId`s
after deduplicating the source records. Use the actual attempt time (submit time for an order, block time for a local
denial), not a broker update time. Supply terminal timestamps at or after the attempt and at or before `asOf`.

The input is `bayn.order-rejection-evidence.v1`; it is not the [live profitability audit](live-profitability-audit-runbook.md)
fixture format. Keep the export private. Do not include account identifiers, credentials, raw broker messages, or
unknown fields. The analyzer does not verify export provenance or completeness. Check the population and cut before
interpreting the result: a low rate in a partial export is not evidence of a healthy strategy.

- Use `CASH`, `MARGIN`, or `PORTFOLIO_MARGIN` as observed at the attempt (`accountTier` is not inferred from equity).
- Use `BUY`/`SELL` and `FILLED`, `CANCELED`, `EXPIRED`, `REJECTED`, or `BLOCKED`. The `FILLED` quantity must equal
  the requested quantity. `REJECTED` and `BLOCKED` must have zero fills. A terminal `CANCELED` or `EXPIRED` attempt
  may have a partial fill; only the remainder was missed.
- Quantities are decimal integer strings in billionths of a share; prices are positive decimal integer strings in
  USD micros per share. Supply the price used to value the intended order (`valuationPriceMicros`), such as the order
  limit or the retained sizing price for a pre-submit block. If sizing is unknown, do not invent an amount.
- Attribute one observed primary cause. For `PDT_BLOCK`, `BUYING_POWER`, `WASH_TRADE_GUARD`, `STALE_QUOTE`,
  `MARKET_HALT`, and `BROKER_ERROR`, set `reason` from the recorded guard or terminal broker evidence. Never use
  `BROKER_ERROR` as a fallback for an unexplained cancel or an unresolved submission. Unknown causes fail the fixture.
- To derive `COLLAR_MISS`, omit `reason` and supply `collarQuote` for a zero-fill limit order that canceled or expired.
  Use the latest retained executable IEX quote at or before the attempt, at most one second old. Both sides must be
  positive and uncrossed. The ask must be strictly above a buy limit or the bid strictly below a sell limit. That is
  evidence of an outside-collar quote at submit, not proof the limit never became executable.
- On a missed attempt only, optionally include `markout`: the observed reference price at the attempt and the same
  symbol's first full one-minute bar starting strictly after the attempt. The bar must have completed by `asOf`.
  If either mark is missing, omit `markout`; do not substitute a later bar, an in-progress bar, or a different session.

UTC timestamps end in `Z` and may have up to nine fractional digits. The time buckets are half-open New York clock
ranges: `0000_0930`, `0930_1000`, `1000_1530`, `1530_1600`, `1600_2400`. They follow daylight saving time but are
not a trading calendar; e.g. a 13:00 early-close event is still in `1000_1530`.

### Synthetic example

```json
{
  "schemaVersion": "bayn.order-rejection-evidence.v1",
  "asOf": "2026-11-27T14:32:00Z",
  "attempts": [
    {
      "attemptId": 1,
      "symbol": "QQQ",
      "accountTier": "MARGIN",
      "side": "BUY",
      "outcome": "FILLED",
      "attemptedAt": "2026-11-27T14:30:00Z",
      "terminalAt": "2026-11-27T14:30:00.250Z",
      "quantityAtoms": "2000000000",
      "filledQuantityAtoms": "2000000000",
      "valuationPriceMicros": "100000000"
    },
    {
      "attemptId": 2,
      "symbol": "QQQ",
      "accountTier": "MARGIN",
      "side": "BUY",
      "outcome": "CANCELED",
      "attemptedAt": "2026-11-27T14:30:00.250Z",
      "terminalAt": "2026-11-27T14:30:55Z",
      "quantityAtoms": "2000000000",
      "filledQuantityAtoms": "0",
      "valuationPriceMicros": "100000000",
      "collarQuote": {
        "at": "2026-11-27T14:29:59.250Z",
        "limitPriceMicros": "100000000",
        "bidPriceMicros": "100000000",
        "askPriceMicros": "100010000"
      },
      "markout": {
        "referencePriceMicros": "100000000",
        "barStartAt": "2026-11-27T14:31:00Z",
        "barCloseMicros": "101000000"
      }
    }
  ]
}
```

Expect one collar miss in two attempts (50%), $200 missed notional, 100 missed bps, and 0 adverse bps (one marked
miss). The overall rate gives `CRITICAL` / `CRITICAL_RATE` and exit 2.

## Read and triage the report

- **Rejection rate:** terminal attempts with an unfilled remainder divided by all terminal attempts in the scope,
  including full fills and pre-submit blocks. This is an attempt rate, not a unique signal, quantity, or capital rate.
- **Missed notional:** sum of unfilled shares × valuation price, truncated once per row to whole USD micros (JSON
  `missedNotionalMicros`). It is attempted exposure, not lost P&L. Retried attempts are counted separately.
- **Markout:** sign the bar move by side (`+` for buys, `−` for sells). Missed bps count the positive part (favorable
  had the position filled); adverse bps count the magnitude of the negative part (an adverse move the miss avoided).
  Each uses the same denominator: total unfilled reference notional of **marked misses**. Unmarked misses do not
  contribute to either estimate. With no marked misses both values are unavailable (`null` in JSON). The fixed
  horizon, coverage, spread, fees, and unknown fill probability limit what this estimate says about realized alpha.

Severity applies to the overall report, in priority order. These are triage thresholds, not risk-policy settings:

| Severity   | Binding condition                                                                         |
| ---------- | ----------------------------------------------------------------------------------------- |
| `CRITICAL` | Any observed `PDT_BLOCK`, otherwise an overall rejection rate of at least 10%.            |
| `WARNING`  | Overall rate of at least 5%, otherwise any unmeasured miss (no `markout`).                |
| `OK`       | Below both rate thresholds and every observed miss has a markout, or there are no misses. |

Rate comparisons use exact counts before display rounding. `0` means `OK` (or `--help`); `2` means a valid report
flagged for triage (`WARNING` or `CRITICAL`) and still produces stdout. `1` means no valid report: an unreadable
fixture, an invalid argument or evidence (including an empty population), or an unexpected failure. Diagnostics go to
stderr without raw paths or input. Investigate failed evidence before retrying the report. For a valid alarm, use the
cause and cohort rows to check the retained guard decision, account tier, quote, or terminal broker record in the
approved read-only evidence. Escalate a confirmed PDT block to the Bayn operator; do not bypass it.
