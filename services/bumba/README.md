# Bumba

Bumba is the Temporal worker that reconciles the one Atlas code-search corpus from the exact current
`origin/main` Git tree. Jangar owns the existing `atlas` schema; Bumba is its only code-corpus writer.

The production contract and acceptance gates are in `../../docs/atlas/production-code-search-design.md`.

## Atlas ingestion contract

- The only Atlas ingestion workflow is `reconcileAtlasRepository`.
- A GitHub push supplies traceability, but the worker always fetches and resolves the current `origin/main`; webhook
  changed-file lists are never treated as the corpus manifest.
- `atlas.file_keys` is the exact eligible-path manifest. Each path has one current file version and its current chunks
  and 1,024-dimensional embeddings.
- Reconciliation sets `repositories.metadata.indexStatus=building`, which makes every search surface fail closed.
- Files are prepared and committed in bounded batches to the existing tables. The worker never retains a whole-repository
  embedding set in memory and never writes a shadow schema or replacement corpus.
- Each batch is fenced by a build ID and exact target commit. Manual, UI, and event callers share one
  repository-scoped Temporal workflow ID, and GitHub events are serialized per repository.
- The activity has a 90-second Temporal heartbeat timeout and sends progress every 15 seconds. A worker crash therefore
  becomes a retry instead of leaving a dead 24-hour activity. Retries reuse heartbeat state and already committed batches.
- The final transaction verifies every path, Git object ID, commit, chunk, and configured embedding before changing the
  repository to `ready`. Any failure leaves Atlas unavailable with an explicit error; there is no fallback corpus.

The event consumer is controlled by `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED`. Keep it `false` during a destructive rebuild.
After live `atlas:verify` passes, enable the same consumer through GitOps. Relevant tuning controls are
`BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS`, `BUMBA_GITHUB_EVENT_BATCH_SIZE`,
`BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK`, `BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES`,
`BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS`, and `BUMBA_ATLAS_PREPARE_CONCURRENCY`.

## Worker deployment routing

The worker starts its Temporal poller, aligns the Worker Deployment to its configured `TEMPORAL_WORKER_BUILD_ID`, and
waits for `routingConfigUpdateState=COMPLETED`. Only then does it report ready or start the GitHub event consumer. Routing
alignment has no bypass toggle.

If propagation is stuck, inspect the Worker Deployment. Delete a stale version only when it is not current or ramping, is
drained, and Temporal reports zero pinned workflows. Do not relax the `COMPLETED` gate. See
`../../docs/runbooks/bumba-temporal-failure-modes.md`.

## Operator command

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

This starts exactly one full-main reconciliation and waits for its Temporal result. Per-file and partial-repository Atlas
CLI entrypoints have been removed.

## Other worker behavior

`publishMainMergeMemoryNote` is independent from Atlas indexing. After a terminal main-branch event, it evaluates a
bounded Git diff and may write durable engineering knowledge through the Agents memory-note API. Its failure does not
change Atlas corpus readiness.

Temporal connection uses `TEMPORAL_*`. The worker-local repository is normally `/workspace/lab`. Embedding configuration
uses `ATLAS_CODE_SEARCH_EMBEDDING_MODEL` and `ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION`; generic model settings must not
override the Atlas-specific contract.
