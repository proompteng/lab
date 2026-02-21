# bumba

Temporal worker that enriches repository files using AST context + self-hosted models and stores embeddings in the Jangar database.

## Notes
- Schema is owned by Jangar; this service only reads/writes through shared tables.
- Configure Temporal connection via `TEMPORAL_*` env vars.
- Mount the Jangar workspace PVC at `/workspace` for file access.
- `enrichWithModel` uses the same Temporal task queue as the workflow (`TEMPORAL_TASK_QUEUE`); do not run a separate model queue.
- Enrichment skips directory paths; model completion failures (including timeouts) fail the workflow to avoid placeholders.
- Performance knobs: `OPENAI_API_BASE_URL`, `OPENAI_COMPLETION_TIMEOUT_MS`, `OPENAI_COMPLETION_MAX_OUTPUT_TOKENS`, `BUMBA_MODEL_CONCURRENCY`,
  `OPENAI_EMBEDDING_API_BASE_URL` (set to Ollama `/api` for batching), `OPENAI_EMBEDDING_BATCH_SIZE`, `OPENAI_EMBEDDING_KEEP_ALIVE`,
  `OPENAI_EMBEDDING_TRUNCATE` (defaults to false for quality), and `OPENAI_EMBEDDING_TIMEOUT_MS`.
- Resilience knobs: `BUMBA_COMPLETION_CONCURRENCY`, `BUMBA_EMBEDDING_CONCURRENCY`, `OPENAI_COMPLETION_MAX_ATTEMPTS`,
  `OPENAI_COMPLETION_RETRY_INITIAL_MS`, `OPENAI_COMPLETION_RETRY_MAX_MS`, `OPENAI_COMPLETION_RETRY_BACKOFF`,
  `OPENAI_COMPLETION_REPAIR_OUTPUT_CHARS`, `OPENAI_EMBEDDING_MAX_ATTEMPTS`, `OPENAI_EMBEDDING_RETRY_INITIAL_MS`,
  `OPENAI_EMBEDDING_RETRY_MAX_MS`, `OPENAI_EMBEDDING_RETRY_BACKOFF`, `OPENAI_EMBEDDING_BATCH_WINDOW_MS`,
  `OPENAI_EMBEDDING_MAX_BATCH_CHARS`.
- `enrichRepository` keeps 24 child workflows in flight by default; if `maxFiles` is set it becomes the default concurrency. Override via `childWorkflowConcurrency` input or `--child-workflow-concurrency` in the CLI.

## CLI helpers
- `bun run packages/scripts/src/bumba/enrich-file.ts --file <path> --wait`
- `bun run packages/scripts/src/bumba/enrich-repository.ts --path-prefix <dir> --max-files <n> --wait`
