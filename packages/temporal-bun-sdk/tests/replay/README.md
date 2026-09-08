# Replay Regression Harness

This directory contains deterministic replay fixtures for **TBS-001**. Each
fixture encodes a Temporal workflow history plus the determinism snapshot that
`ingestWorkflowHistory` should reconstruct. The fixtures power
`tests/replay/fixtures.test.ts` and the stricter manifest verifier
`scripts/verify-replay-corpus.ts`.

The `captured-*` fixtures were generated from a Temporal CLI dev server by
`scripts/capture-replay-corpus.ts`. They are real Temporal histories. The
current corpus covers the replay feature tags required by
`verify:production`, but default-choice readiness still depends on broader
async-fuzz, load, soak, CI, and production-operation gates.

## Adding or Refreshing Fixtures

1. Prefer the capture script for supported integration scenarios:
   ```bash
   cd packages/temporal-bun-sdk
   bun run capture:replay-corpus
   bun run verify:replay-corpus
   ```
2. For a one-off fixture, run the workflow against a Temporal dev server and
   export the history as JSON via the Temporal CLI:
   ```bash
   temporal workflow show --workflow-id <id> --output json --history > /tmp/history.json
   ```
3. Normalize the history into the lightweight JSON schema used here. Use Buf
   generated types (`toJson(HistoryEventSchema, event)`) so event enum and
   bigint fields stay stable.
4. Place the resulting `*.json` file under `tests/replay/fixtures/` and update
   `tests/replay/corpus/manifest.json`.

Each fixture must include:

- `info`: namespace, task queue, workflow id/run id, workflow type, optional Temporal version.
- `history`: array of raw workflow `HistoryEvent` objects.
- `expectedDeterminismState`: the determinism snapshot derived from the history
  (command intents, random/time streams, and optional metadata).

The manifest entry must include `featureTags`, `commandKinds`,
`historyEventTypes`, `historyEventCount`, `expectedCommandCount`, Bun version,
SDK version, Temporal server/CLI version, and payload codec profile where
applicable. It may also include `externalOperationKinds` for client-side
operations such as signal, query, update, cancel, terminate, or operator setup.
The verifier fails if `commandKinds` or declared `historyEventTypes` drift from
the replayed determinism state and fixture history.

## Running the Harness

Execute from the repo root:
```bash
cd packages/temporal-bun-sdk && bun test tests/replay/fixtures.test.ts
```

Set `TEMPORAL_REPLAY_FIXTURE=<name>` to limit the run to fixtures whose filenames
contain the provided substring when iterating on large histories.
