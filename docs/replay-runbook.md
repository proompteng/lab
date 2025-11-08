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
   and run `pnpm --filter @proompteng/temporal-bun-sdk exec bun test tests/replay/fixtures.test.ts`.
   Use `TEMPORAL_REPLAY_FIXTURE=<name-fragment>` to run a subset.

## Sticky Cache Tuning & Debugging

- `TEMPORAL_STICKY_CACHE_SIZE`: maximum number of cached determinism snapshots
  (default `128`).
- `TEMPORAL_STICKY_TTL_MS`: cache TTL in milliseconds (default `5m`).
- `TEMPORAL_STICKY_SCHEDULING_ENABLED`: set to `0`/`false` to disable sticky
  scheduling entirely when debugging nondeterminism. WorkerRuntime also exposes a
  `stickyScheduling` option for programmatic overrides.

The cache now exposes metrics via the `observability/metrics.ts` interface:

| Metric | Description |
| --- | --- |
| `temporal_worker_sticky_cache_hits_total` | snapshot reuse events |
| `temporal_worker_sticky_cache_misses_total` | rebuilds due to stale/missing snapshots |
| `temporal_worker_sticky_cache_evictions_total` | LRU/TTL evictions inside the cache |
| `temporal_worker_sticky_cache_heal_total` | entries cleared after nondeterminism |

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
     and event type
4. Inspect sticky cache metrics to determine whether mismatches are caused by
   stale snapshots (misses + evictions climbing) or fresh history (hits > 0).

## Running the Replay Harness

```
pnpm --filter @proompteng/temporal-bun-sdk exec bun test \
  tests/workflow/replay.test.ts \
  tests/replay/fixtures.test.ts
```

The first suite exercises ingestion logic directly; the second replays captured
histories to guard against regressions.
