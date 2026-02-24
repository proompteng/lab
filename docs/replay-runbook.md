# Temporal Bun SDK Replay Runbook

This runbook explains how to capture workflow histories, exercise the replay
harness, and tune sticky cache + determinism diagnostics for
`@proompteng/temporal-bun-sdk`.

## Capturing Workflow Histories

1. Deploy or start a Temporal dev server (the integration harness can reuse an
   existing instance by setting `TEMPORAL_TEST_SERVER=1`).
2. Execute the workflow you want to capture. Use descriptive workflow ids so the
   fixture metadata remains readable.
3. Export the history via the Temporal CLI:
   ```bash
   temporal workflow show \
     --workflow-id <workflow-id> \
     --output json \
     --history > /tmp/history.json
   ```
4. Normalize the history into the fixture schema. The helper
   `scripts/build-replay-fixtures.ts` shows how existing fixtures were generated
   with Buf-generated types. Update the script or write a similar one and run:
   ```bash
   NODE_PATH=packages/temporal-bun-sdk/node_modules bun scripts/build-replay-fixtures.ts
   ```
5. Drop the resulting JSON file into `packages/temporal-bun-sdk/tests/replay/fixtures/`
   and run `cd packages/temporal-bun-sdk && bun test tests/replay/fixtures.test.ts`.
   Use `TEMPORAL_REPLAY_FIXTURE=<name-fragment>` to run a subset.

## Use the CLI replay command

The new `temporal-bun replay` CLI wraps the determinism ingestion pipeline so
you no longer need ad-hoc scripts or Bun tests to diff histories:

1. Set the same environment variables that power workers/clients
   (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, TLS/API keys, etc.).
2. For JSON fixtures, run:
   ```bash
   bunx temporal-bun replay \
     --history-file packages/temporal-bun-sdk/tests/replay/fixtures/timer-workflow.json \
     --workflow-type timerWorkflow \
     --json
   ```
3. For live executions, target either the Temporal CLI (`--source cli`) or the
   WorkflowService RPC API (`--source service`). `--source auto` (default) tries
   the CLI first and then falls back to RPCs when the binary is missing.
   ```bash
   TEMPORAL_ADDRESS=127.0.0.1:7233 TEMPORAL_NAMESPACE=temporal-bun-integration \
     bunx temporal-bun replay \
     --execution workflow-id/run-id \
     --workflow-type integrationWorkflow \
     --namespace temporal-bun-integration \
     --source cli \
     --json
   ```
4. Override the Temporal CLI location with `--temporal-cli` or
   `TEMPORAL_CLI_PATH` when it is not on `PATH`, and pass `--source service` to
   talk to WorkflowService directly in CI environments.

Exit codes follow Temporal standards (`0` success, `2` nondeterminism, `1`
failures). The CLI logs history provenance, event counts, mismatch metadata, and
emits a compact JSON summary when `--json` is supplied so you can attach the
output to incident threads or feed it into scripts.

### Replay Diagnostics Environment

- `TEMPORAL_TEST_SERVER=1` — reuse an already running Temporal dev server instead of spawning the CLI helper (tests log a skip if the CLI is missing).
- `TEMPORAL_BUN_SDK_TRACE_PATH=/tmp/temporal-bun-trace.jsonl` — emit structured trace lines for every workflow task, replay diff, and sticky cache decision. Tail this file while running the harness to correlate mismatches with the history events reported in `WorkflowNondeterminismError.details`.

## Sticky Cache Tuning & Debugging

- `TEMPORAL_STICKY_CACHE_SIZE`: maximum number of cached determinism snapshots
  (default `128`).
- `TEMPORAL_STICKY_TTL_MS`: cache TTL in milliseconds (default `5m`).
- `TEMPORAL_STICKY_SCHEDULING_ENABLED`: set to `0`/`false` to disable sticky
  scheduling entirely when debugging nondeterminism. WorkerRuntime also exposes a
  `stickyScheduling` option for programmatic overrides.

The cache now exposes metrics via the `observability/metrics.ts` interface:

| Metric                                         | Description                             |
| ---------------------------------------------- | --------------------------------------- |
| `temporal_worker_sticky_cache_hits_total`      | snapshot reuse events                   |
| `temporal_worker_sticky_cache_misses_total`    | rebuilds due to stale/missing snapshots |
| `temporal_worker_sticky_cache_evictions_total` | LRU/TTL evictions inside the cache      |
| `temporal_worker_sticky_cache_heal_total`      | entries cleared after nondeterminism    |

Attach your own registry via `WorkerRuntimeOptions.metrics` or call
`makeStickyCache({ metrics: {...} })` when supplying a custom cache.

## Diagnosing Nondeterminism

1. The worker now logs sticky cache decisions with fields: namespace, task queue,
   workflow id/run id, workflow type, workflow task attempt, and
   `nondeterminismRetry` (0 for first attempt, 1 after history refresh).
2. When nondeterminism occurs, the worker clears the sticky cache entry, fetches
   history again, and retries the workflow task once before surfacing the
   failure via `WorkflowTaskFailedCause.NON_DETERMINISTIC_ERROR`.
3. `WorkflowNondeterminismError.details` now includes:
   - `workflow`: namespace/task queue/workflow id/run id/type
   - `workflowTaskAttempt`
   - `stickyCache`: cached & history event ids used for comparison
   - `mismatches`: command index, history event id, workflow task completed id,
     and event type. The diff also records `signal` entries (name + payload
     hash + originating history metadata) and `query` entries (name + request
     hash + handler name + result hash) so you can see when inbound workflows
     tried to consume different signals/queries between runs.
4. Inspect sticky cache metrics to determine whether mismatches are caused by
   stale snapshots (misses + evictions climbing) or fresh history (hits > 0).
5. `ingestWorkflowHistory` captures `WORKFLOW_EXECUTION_SIGNALED` events and
   query evaluations inside determinism snapshots so sticky cache entries and
   replay diagnostics contain the same inbound metadata that the workflow saw
   during live execution.

## Running the Replay Harness

```
cd packages/temporal-bun-sdk && bun test \
  tests/workflow/replay.test.ts \
  tests/replay/fixtures.test.ts
```

The first suite exercises ingestion logic directly; the second replays captured
histories to guard against regressions.
