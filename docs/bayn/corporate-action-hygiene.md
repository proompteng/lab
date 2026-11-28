# Bayn corporate-action hygiene

Run this offline check on evidence for the [three-account sleeves](three-account-capital-plan.md): F4 and O1 use
all-adjusted daily bars for signals and finalized raw closes for next-open whole-share sizing; B0 must not use a
split or ex-dividend gap as alpha. The verifier reads one local JSON file and writes only to stdout/stderr. It does
not call a provider, change a sleeve, edit a freeze, or confer authority to trade.

```sh
bun services/bayn/tools/verify-corporate-action-hygiene.ts --input /private/hygiene-evidence.json
```

## Prepare the evidence

Use trusted point-in-time records. The [multi-account sleeve runner](multi-account-sleeve-architecture.md) does not
emit this evidence envelope: combine its signal and sizing inputs with independent raw marks, a corporate-action
archive, and the B0 decisions being checked. Do not derive the raw reference from the same adjusted series or use
today's broker asset flags to certify a past decision. Keep the input private.

- `calendar` is the ordered regular-session calendar for the slice, including the prior close and each daily sleeve's
  next execution session. Do not drop intervening sessions to make two bars appear adjacent.
- In `corporateActions`, supply one record per symbol and effective session (the **ex-date** for a dividend),
  including the next open for every daily observation. Use `split: null` and `cashDividendMicros: 0` only for a
  verified no-action session. An unavailable archive or unsupported event such as a reorganization must not be
  recorded as no action; omit that action record and the check fails closed. A 2-for-1 split is
  `{ "fromShares": 1, "toShares": 2 }`; express cash distributions per post-split share if both happen together.
- Each observation represents a symbol, sleeve and consecutive regular-session pair. Use raw closing and opening
  marks for that pair and positive integer microdollars (`$1 = 1000000`). For F4/O1, `signal` contains the actual
  all-adjusted marks from the same captured signal series. `sizing.priceMicros` is the actual **reference** used for
  sizing, not the limit or fill; `sizing.rawCloseMicros` is the independently verified raw close from `session`.
- For B0, use `overnightGapUse: "excluded"` only if the recorded gap did not feed any alpha calculation, including
  a previous-close anchor or derived input. Otherwise use `"used-for-alpha"`. List every new or increased short
  entry in `shortEntries` as `{ "decisionAt": "…", "eligibility": { … } }` with its captured
  [`bayn.equity-short-eligibility.v1` evidence](../../services/bayn/src/execution/equity-short.ts). Use `eligibility: null`
  for missing proof, and `shortEntries: []` only when no short entry was attempted in the observation.

Example (synthetic ex-date; O1 uses the same shape as F4):

```json
{
  "schemaVersion": "bayn.corporate-action-hygiene-evidence.v1",
  "calendar": ["2026-11-20", "2026-11-23", "2026-11-24"],
  "corporateActions": [
    { "symbol": "QQQ", "session": "2026-11-23", "split": null, "cashDividendMicros": 500000 },
    { "symbol": "QQQ", "session": "2026-11-24", "split": null, "cashDividendMicros": 0 }
  ],
  "observations": [
    {
      "sleeve": "F4",
      "symbol": "QQQ",
      "previousSession": "2026-11-20",
      "session": "2026-11-23",
      "rawPreviousCloseMicros": 100000000,
      "rawOpenMicros": 101000000,
      "signal": { "basis": "all", "previousCloseMicros": 49750000, "openMicros": 50500000, "closeMicros": 51000000 },
      "sizing": {
        "basis": "raw",
        "priceMicros": 102000000,
        "rawCloseMicros": 102000000,
        "referenceSession": "2026-11-23",
        "executionSession": "2026-11-24"
      }
    },
    {
      "sleeve": "B0",
      "symbol": "QQQ",
      "previousSession": "2026-11-20",
      "session": "2026-11-23",
      "rawPreviousCloseMicros": 100000000,
      "rawOpenMicros": 101000000,
      "accountId": "11111111-1111-4111-8111-111111111111",
      "overnightGapUse": "excluded",
      "shortEntries": []
    }
  ]
}
```

## Read the result

- **Overnight jumps:** compare the regular open to the prior raw close on the new share basis
  (`raw close × fromShares / toShares − cash dividend per share`). A remaining move strictly greater than 20% in
  either direction, or a jump that big in the supplied daily signal marks, blocks the evidence. A listed event does
  not waive an unexplained residual. The threshold catches suspect gaps, not just splits; investigate rather than
  assuming the cause.
- **F4/O1:** require `all` for signals and `raw` for sizing, even if the numbers coincide. Match adjusted and raw
  returns both across the corporate-action boundary and from open to close, allowing only nearest-microdollar
  rounding on the signal marks.
  Require the sizing mark to match the finalized raw close for the signal session. A split at the following open
  blocks that reference because it is in pre-split share units.
- **B0:** `ExDividendGap` and `SplitGap` identify affected rows regardless of the raw gap's size or direction.
  The report fails if the gap fed alpha. Each short entry needs eligible account, configuration and asset
  observations matching its account and symbol, at or before the decision and less than 15 seconds old. This
  reuses Bayn's short eligibility check; a pass is not a locate or a guarantee of later inventory.

Exit `0` with a `PASS` report means the supplied rows had no anomalies. Exit `1` with a `FAIL` report means withhold
the evidence and investigate the listed anomalies. `flags` are informational; the example passes with two
`ExDividendGap` flags. Findings use zero-based indices into `observations` or `corporateActions`, and into
`shortEntries` where applicable. An unreadable or invalid input exits `1` with a redacted error on stderr instead
of a report. Neither output includes account IDs, file paths or prices.

`checkedBySleeve` reports scope, not completeness: compare coverage against the intended symbols, sessions, and
short decisions. The tool cannot authenticate the file's origin or infer omitted decisions or sessions. Do not use
the report in place of the O1 market hash/attestation, broker inventory reconciliation, or other Paper/live gates.
