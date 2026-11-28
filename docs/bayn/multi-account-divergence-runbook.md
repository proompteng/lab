# Bayn three-account divergence verifier (Wave 21L)

Compare Live Main against Paper Main and Paper $10k on the same shadow protocol and trading sessions. Use this check
to investigate drift before sleeve graduation. A `PASS` is evidence parity within the stated limits, not evidence of
profitability, settlement certification, or permission to trade. Do not compare unrelated sleeves and treat the findings
as shadow drift.

## Run it offline

From the repository root, install the pinned dependencies if needed:

```sh
bun install --frozen-lockfile --ignore-scripts --filter @proompteng/source --filter @proompteng/bayn
bun services/bayn/tools/verify-multi-account-divergence.ts \
  --fixture /private/bayn-shadow-evidence.json --format json
```

Use `--format markdown` (the default) for operator review. The only input is a local regular JSON file. The verifier
makes no broker, database, or network calls and writes no files. Do not give it credentials, account numbers, DB URLs,
raw broker payloads, or frozen protocol artifacts. Prepare and retain evidence outside the repository.

## Prepare normalized evidence

Use `schemaVersion: "bayn.multi-account-divergence-evidence.v1"`. Declare the nonempty `sessionDates` you intend to
verify from the exchange calendar and a nonempty `allowedSymbols` list from the reviewed shadow policy, **not** from
observed activity. `accounts` must have exactly these keys: `LIVE_MAIN`, `PAPER_MAIN`, and `PAPER_SMALL_10K`. Each
contains the independently verified Bayn broker `identityHash` and a `sessions` array. The three identity hashes must
be distinct. The tool checks the supplied bindings for consistency; it cannot authenticate their origin or discover a
session omitted from `sessionDates`. A date declared but not supplied for an account fails.

For each account and session, supply:

| Field                               | Source and normalization                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`, `openAt`, `closeAt`, `asOf` | New York trading date and verified regular open and close, including early closes. UTC cuts use `YYYY-MM-DDTHH:mm:ss.sssZ`. Use the **same** logical `asOf` cut, at or after the regular close, for all three accounts, not each receipt's export time.                 |
| `complete`                          | Set `true` only after the retained decision, order, fill, account, and fee evidence has been reconciled through that cut, including late postings attributable to the session. Set `false` for missing or unresolved evidence; don't substitute empty arrays or zeroes. |
| `openingEquityMicros`               | Positive USD equity at the common opening mark, as an integer string in millionths of a dollar. Use actual equity, not the account's label, buying power, or nominal starting value.                                                                                    |
| `pdtDayTrades`                      | Reconciled number of day trades counted for the session. Supply a nonnegative integer, not a rolling broker day-trade counter or the number of fills.                                                                                                                   |
| `unattributedFeeMicros`             | Nonnegative posted session fees not already included in fills, such as separately posted regulatory charges. Use `"0"` only for verified zero. Do not double-count direct fees or include fees from another session.                                                    |
| `signals`                           | Each row has `slot`, `symbol`, `side` (`BUY` or `SELL`), and `at` (actual decision time, not source bar time).                                                                                                                                                          |
| `orders`                            | Each row has `slot`, `symbol`, `side`, `type` (`MARKET`, `LIMIT`, or `STOP_LIMIT`), the Bayn `status` at the cut, `quantityAtoms`, `referenceMicros`, `limitMicros`, `stopMicros`, and `fills`. Null price terms are required when inapplicable.                        |
| `orders[].fills`                    | Each row has a unique per-account `executionHash` (SHA-256 of the retained fill identity), `at`, `quantityAtoms`, `priceAtoms`, and `feeMicros`. Nest it under its verified owning order. Timestamps can retain up to nine fractional digits.                           |

Slots are nonnegative integer identifiers derived from shared strategy intent (separate namespaces for signals and
orders). Assign them the same way on all three accounts, including replacement and exit orders. Do not renumber based
on what each account observed: losing an early decision or order must not shift all later slots. Two orders for the same
symbol and side still need different slots. `referenceMicros` is the same pre-established benchmark for that order
slot on all accounts, not a benchmark selected independently after observing each fill.

Amounts and quantities are canonical base-10 integer strings. Quantity and **fill** price atoms are in billionths of a
share and of a dollar per share, respectively; order prices and fees are in millionths of a dollar (per share for order
prices). Use the actual event time: all signals and fills must belong to the declared New York date and be at or before
`asOf`. Supply the complete fill lifecycle of each session order; an order with fills split across different session
dates is outside this evidence contract. A filled order with missing fill rows is invalid evidence, not a zero-fill order.

The [live profitability audit](live-profitability-audit-runbook.md) describes the retained execution evidence and its
units. Its single-account outputs and the [daily sleeve receipts](multi-account-sleeve-architecture.md) are not direct
inputs to this tool. Normalize audited decisions, orders, reconciled account marks and PDT counts, and settled fills and
fees from independently verified account evidence before running the verifier.

## Read the result

Every reported delta is **Paper − Live** for the named shadow account. A positive PDT delta means extra day trades in
that shadow. Positive slippage is adverse for either side. Fill fragments may differ across accounts: parity checks
the total filled fraction of the submitted quantity, not literal fill IDs or the number of fill rows.

| Optional `thresholds` key | Default | Compared metric                                                                                                                               |
| ------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSignalDelayMs`        |   1,000 | Absolute timestamp drift for each matching signal.                                                                                            |
| `maxWeightDeltaBps`       |      50 | Per-order requested notional at the common reference and realized gross fill notional, each divided by opening equity.                        |
| `maxSlippageDeltaBps`     |     2.5 | Per matched filled order: side-adjusted difference between executed value and reference value, divided by reference value at filled quantity. |
| `maxFeeDeltaBps`          |       1 | Direct fees per matched filled order, and total posted fees per session including unattributed fees, divided by gross filled notional.        |
| `maxPdtCountDelta`        |       0 | Absolute difference in reconciled session day trades.                                                                                         |

Set any overrides in the fixture before looking at results. Milliseconds and counts are nonnegative integers. Basis
point limits are numeric values from 0 to 10,000 with at most three decimal places. A metric fails only when its absolute
delta is **greater than** the limit. Ratio comparisons use exact arithmetic before rounding the report to six decimal
places. These are divergence limits, not the live audit's separate profitability or round-trip slippage gates.

- `PASS` (exit 0): both comparisons passed for every declared date with matching signal and fill samples.
- `WARN` (nonzero): a comparable cut has no matching signal or no comparable filled order. `null` in JSON and `—` in
  Markdown mean unavailable, not zero. Idle sessions cannot certify parity; collect a representative sample.
- `FAIL` (nonzero): review the named date, shadow, finding code, and slot against the private input. A missing or
  incomplete snapshot, different cut, symbol outside the allowlist, missing or changed signal/order, unequal fill
  fraction, or threshold breach blocks the gate. Reconcile the retained evidence before rerunning; don't widen the
  allowlist or thresholds to suppress a finding.

The overall verdict is the worst comparison verdict. Completed comparisons write their report to stdout even when
they do not pass. Argument, file, JSON, and evidence-validation errors write only a redacted JSON diagnostic with
`severity: "FAIL"` to stderr and produce no comparison report. Reports use fixed account labels and logical slots;
they do not print account or execution identities, raw symbols, paths, or fixture contents.

## Try it with synthetic evidence

This creates a temporary fixture with one scaled buy on each account. It should produce `PASS` and a 1,000 bps weight
on all three accounts. It uses no real identifiers, credentials, or market data.

```sh
fixture=$(mktemp)
bun -e '
  const date = "2026-11-27";
  const at = `${date}T14:31:00.000Z`;
  const accounts = Object.fromEntries([
    ["LIVE_MAIN", 100, 1], ["PAPER_MAIN", 50, 2], ["PAPER_SMALL_10K", 10, 3],
  ].map(([role, shares, id]) => [role, {
    identityHash: String(id).padStart(64, "0"),
    sessions: [{
      date, openAt: `${date}T14:30:00.000Z`, closeAt: `${date}T18:00:00.000Z`,
      asOf: `${date}T23:00:00.000Z`, complete: true,
      openingEquityMicros: String(shares * 1e9), pdtDayTrades: 0, unattributedFeeMicros: "0",
      signals: [{ slot: 0, symbol: "QQQ", side: "BUY", at }],
      orders: [{
        slot: 0, symbol: "QQQ", side: "BUY", type: "MARKET", status: "FILLED",
        quantityAtoms: String(shares * 1e9), referenceMicros: "100000000", limitMicros: null, stopMicros: null,
        fills: [{ executionHash: String(id + 3).padStart(64, "0"), at,
          quantityAtoms: String(shares * 1e9), priceAtoms: "100000000000", feeMicros: "0" }],
      }],
    }],
  }]));
  console.log(JSON.stringify({ schemaVersion: "bayn.multi-account-divergence-evidence.v1",
    sessionDates: [date], allowedSymbols: ["QQQ"], accounts }));
' > "$fixture"
bun services/bayn/tools/verify-multi-account-divergence.ts --fixture "$fixture" --format markdown
rm "$fixture"
```
