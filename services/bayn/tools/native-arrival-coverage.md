# Bounded original-arrival coverage audit

Run from `services/bayn` against a private local evidence bundle:

```sh
bun tools/native-arrival-coverage.ts /private/native-coverage.json > /private/audited-quotes.json
```

This command has no database, Kafka, broker, model or network client. Keep production input and output private.
The library export `auditNativeArrivalCoverage(input)` returns a typed `Result` containing `report` and `quotes`.
Quotes use the existing `ObservedMarketValue<IntradayQuote>` type and production raw decoder; their original
availability, projection sequence, raw-value hash, native payload and source coordinates are unchanged.

The JSON bundle contains:

- `epoch`: `{ contentHash, epoch }` from the retained native epoch.
- `headers`: every `{ contentHash, header }`, ordered from ordinal zero through the retained end.
- `chunks`: a contiguous bounded subset of those headers with `compressedBase64` containing the original gzip bytes.
  Include context before the interval start and a delivery at or after the end. Do not filter deliveries by market.
- `end`: the retained native end receipt, or null when no receipt exists. Never manufacture one.
- `interval`: `{ startMs, endMs }` in UTC epoch milliseconds, with positive duration.
- `symbols`: the requested quote symbols from the original source inventory.

The command accepts at most 32 MiB of JSON, 25,000 headers, 4,096 selected chunks and 128 MiB total decoded chunk bytes.
Existing native decoders verify compressed and uncompressed hashes, original value bytes, arrival sequences and
consumer identity. The audit additionally verifies every header link, selected-chunk continuity, both interval
boundaries, inventory and end linkage. Tampering, missing chunks, invalidated assignments, tombstones and rejected
inputs fail closed. Ignored deliveries retain their place in the global sequence but never become pricing evidence.

`completePrefixBytesVerified` only describes whether every payload in the supplied header prefix was decoded.
It is not complete session, provider or controller coverage. An unsealed/incomplete capture and
`consumerScopeCompleted=false` remain visible. Header verification alone does not verify earlier payload bytes.
Hashes establish consistency with the supplied evidence, not independent origin authenticity; retain trusted source
hashes and original export provenance separately. The output is not a new capture or replay completeness receipt.

Per-symbol counts and maximum arrival gaps include the requested interval boundaries. Absent quotes stay null/empty.
Returned quotes also retain leading/trailing context, so downstream studies must bind and filter their own interval.
Observed quotes may be stale, withdrawn or insufficient for execution; the audit does not grant executable-price status.
Controller coverage and decision commit acknowledgement are always `UNKNOWN`, and qualification is always
`UNQUALIFIED`. No inference from a quote crossing to a fill, realized P&L, strategy edge or capital authority is made.
