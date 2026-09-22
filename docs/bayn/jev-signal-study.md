# Inspect retained Jev entry signals

`services/bayn/tools/jev-signal-study.ts` tests the 15-minute outcomes following retained Jev entry observations.
It reproduces the model's selection and compares two fixed rules using the same candidate evidence and execution
times. The rules are deterministic breakout and positive benchmark-relative momentum. The definition and thresholds
are hashed in the output.

This is a development signal screen. It does not implement the portfolio controls in
[the frozen acceptance protocol](jev-migration-acceptance-v2.json). It cannot establish trading frequency, executable
volume, or net portfolio profit. Hypothetical positions overlap, and the original Jev policy determined which times
were observed while the account was flat. The report retains these sampling limits.

## Prepare the retained evidence

Use a preserved replay database. Export every batch, including missing results and management observations, in one
read-only statement. Keep account and execution records outside the repository.

```sql
SELECT json_agg(json_build_object(
  'observation', o.payload,
  'batchPlan', p.payload,
  'batchResult', r.payload
) ORDER BY o.observed_at, p.batch_id)
FROM jev_batch_plans p
JOIN intraday_candidate_observations o ON o.content_hash = p.observation_hash
LEFT JOIN jev_batch_results r USING (batch_id);
```

The input document has these fields:

| Field           | Value                                                          |
| --------------- | -------------------------------------------------------------- |
| `schemaVersion` | `bayn.jev-signal-study-input.v1`                               |
| `runId`         | The original replay report's run ID                            |
| `source`        | The original backtest input's complete source manifest         |
| `assumptions`   | The original latency, slippage, liquidity, and fee assumptions |
| `batches`       | The exported array above                                       |

Pin the input file's SHA-256 before running. Preserve the original source receipt and its independently recorded
hash. The command validates the entire compressed source, reproduces each studied observation against the ordered
source cursor, and consumes the remaining source before emitting a report. A modified observation, result, source,
or duplicate batch fails the command. Input hashes establish identity; they do not prove that an export contains every
original batch. Verify export counts against the preserved database.

## Run the screen

From the repository root:

```sh
bun services/bayn/tools/jev-signal-study.ts \
  --input study-input.json --input-sha256 <pinned-input-sha256> \
  --arrivals arrivals.ndjson.gz \
  --source-receipt source-receipt.json --source-receipt-sha256 <pinned-receipt-sha256> \
  --output study-report.json
```

The output path must be new. The tool needs no broker credentials, model credentials, or database connection.
It does not make model calls or place broker orders.

Each available candidate gets an independent hypothetical USD 10,000 cash budget. Whole-share sizing fits both
entry notional and buy-side fees within that budget, using the decision quote with a 10 bp limit allowance.
Entry reaches the market after the original routing latency. Exit is submitted
15 minutes after that entry arrival and incurs the same routing latency. Both legs use the replay's IOC fill model,
arrival quote validation, displayed liquidity, adverse slippage, and fee ledger. A partial entry limits the exit to the
actual acquired quantity. A partial exit remains unresolved. A horizon outside the session or source coverage also
remains unresolved.

The native Jev rule uses the actual completed batch and its source-controlled probability threshold. Both deterministic
rules use that same decision time to isolate selection. This does not measure their earliest possible decision time.
Missing or unusable model batches remain visible; they cannot be counted as a model abstention supported by evidence.

Read `summary` together with `observations` and `rows`. The mean is conditional on resolved outcomes. The report lists
unresolved and unfilled hypotheses alongside it and retains fill and quote hashes. Never sum these overlapping
hypotheses into a portfolio P&L or drop unresolved labels to qualify a policy. Model and data costs are not allocated
to the hypothetical returns. Quote-size units and market impact need independent calibration before capacity claims.

Use the screen to choose a development hypothesis for a complete lifecycle simulation. Freeze any final candidate
and its portfolio controls before starting an untouched acceptance window.
