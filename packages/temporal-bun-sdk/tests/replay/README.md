# Replay Regression Harness

This directory contains deterministic replay fixtures captured for **TBS-001**. Each
fixture encodes a Temporal workflow history plus the determinism snapshot that
`ingestWorkflowHistory` should reconstruct. The fixtures power
`tests/replay/fixtures.test.ts`, ensuring that real histories continue to replay
without drift.

## Adding or Refreshing Fixtures

1. Run the workflow against a Temporal dev server (the integration harness under
   `tests/integration` will record representative histories). Export the history
   as JSON via the Temporal CLI:
   ```bash
   temporal workflow show --workflow-id <id> --output json --history > /tmp/history.json
   ```
2. Normalize the history into the lightweight JSON schema used here. The helper
   script `scripts/build-replay-fixtures.ts` demonstrates how the existing
   fixtures were generated (it uses Buf generated types to keep the structure
   consistent). Update the script or write a similar one and execute:
   ```bash
   NODE_PATH=packages/temporal-bun-sdk/node_modules bun scripts/build-replay-fixtures.ts
   ```
3. Place the resulting `*.json` file under `tests/replay/fixtures/` and commit it
   alongside the updated script (if applicable).

Each fixture must include:

- `info`: namespace, task queue, workflow id/run id, workflow type, optional Temporal version.
- `history`: array of raw workflow `HistoryEvent` objects.
- `expectedDeterminismState`: the determinism snapshot derived from the history
  (command intents, random/time streams, and optional metadata).

## Running the Harness

Execute from the repo root:
```bash
cd packages/temporal-bun-sdk && bun test tests/replay/fixtures.test.ts
```

Set `TEMPORAL_REPLAY_FIXTURE=<name>` to limit the run to fixtures whose filenames
contain the provided substring when iterating on large histories.
