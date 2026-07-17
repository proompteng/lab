# Atlas Code Search Repair Plan

Status: The initial in-place repair merged in PR #12459. Production hardening is implemented in the codebase, but Atlas
is not production-proven until the hardened images run, a fresh current-main rebuild completes, and the live Definition
of Done passes.

Evidence baseline: 2026-07-13, repository commit `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`.

## Decision

Atlas is a disposable cache of the current `proompteng/lab` default branch.

- Keep the existing `atlas` schema and tables.
- Run one Atlas service and one ingestion worker.
- Store only the current eligible file version for each path.
- Do not index branches, pull requests, or source history.
- Do not create new schemas, replacement tables, dual writes, shadow indexes, backups, or fallback corpora.
- Fix the code, stop ingestion, truncate Atlas, rebuild from `origin/main`, verify 100%, then reopen it.

Git is the source of truth. If Atlas breaks, truncate and rebuild it.

## Why It Is Broken

The live audit found concrete correctness failures:

- The audited Git tree had 8,183 eligible files. Atlas contained only 5,049 current paths, with 3,134 missing and 1,292
  stale paths.
- Push ingestion ignores deleted paths and trusts changed-path payloads instead of reconciling the exact Git tree.
- Ingestion overwrites `repositories.default_ref` with whichever branch it processes.
- The chunker misses exported arrow functions and leaves source regions uncovered.
- Semantic search vector-ranks only the newest 100 chunks.
- The 4,096-dimensional embedding table has no ANN index.
- Health samples 50 chunks and therefore cannot prove corpus correctness.
- JSON metadata is written as encoded strings instead of objects.
- Request timeouts leave PostgreSQL queries running.
- Source preview reads a mutable, stale local `main` checkout.

The existing table structure is enough. The writers and readers use it incorrectly.

## Existing Tables After Repair

Use the tables as follows:

- `atlas.repositories`: one row for `proompteng/lab`. Keep `default_ref = 'main'`. Store `indexStatus`, `indexedCommit`,
  `treeHash`, expected/indexed/embedded counts, chunker version, embedding configuration, and last error in its existing
  JSON object metadata. While building, store a fenced build ID, target configuration, target commit, and heartbeat
  progress separately from the last ready configuration.
- `atlas.file_keys`: exactly one row for every eligible path in the current `main` tree. This is the manifest.
- `atlas.file_versions`: exactly one row per `file_key_id`. Add a unique index on `file_key_id`; replace the row when
  content changes.
- `atlas.file_chunks`: only chunks for the current file version. Store chunker version and chunk content hash in the
  existing metadata object. Replacing a file version already cascades old chunks.
- `atlas.chunk_embeddings`: one 1,024-dimensional embedding per current chunk, using the existing Saigak model.
- `atlas.enrichments`, `atlas.embeddings`, and `atlas.tree_sitter_facts`: optional derived enrichment. Their failure must
  not block code-search readiness.
- `atlas.github_events` and `atlas.ingestions`: operational delivery history. Preserve these rows during a corpus reset.
- `atlas.event_files` and `atlas.ingestion_targets`: associations into the derived corpus. Clear them through foreign-key
  cascades when `file_keys` and `file_versions` are truncated.
- Existing symbol tables are not required. Exact identifier search can use chunk content and trigram indexes.

Required schema changes are limited to:

1. A unique index on `file_versions(file_key_id)` after the destructive reset.
2. Change `chunk_embeddings.embedding` to `vector(1024)` while the table is empty.
3. Add HNSW on `chunk_embeddings.embedding`.
4. Add trigram indexes for `file_keys.path` and `file_chunks.content`.
5. Add JSON-object constraints after fixing the writers.

No new tables are required.

## Embedding Model And Dimension

Keep `qwen3-embedding-saigak:8b`. Do not deploy another embedding model or change the dimension used by unrelated Saigak
consumers.

Atlas must have its own embedding configuration in Bumba and Jangar:

- `ATLAS_CODE_SEARCH_EMBEDDING_MODEL=qwen3-embedding-saigak:8b`
- `ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION=1024`

The model and dimension are coupled, but changing the Atlas output dimension does not require changing the model.
Qwen3-Embedding-8B was trained with Matryoshka Representation Learning and officially supports user-selected output sizes
from 32 through 4,096 dimensions. The repository originally deployed this same 8B model at 1,024 dimensions for Atlas in
commit `c8b5aec0a`; commit `a30048cb9` later changed the whole self-hosted embedding stack to 4,096 without an Atlas
retrieval evaluation.

The 4,096 configuration cannot remain: pgvector HNSW supports at most 2,000 dimensions for `vector` and 4,000 for
`halfvec`, so neither can index the native output. Use 1,024 because it is a supported MRL output, fits a normal
`vector_cosine_ops` HNSW index, and restores the already-integrated Atlas contract without adding a model or serving path.
This is not accepted on model reputation alone: before truncation, the fixed Atlas query set must pass at 1,024 against
chunks produced from the current Git tree. Failure blocks the rollout and reopens the model/index decision; it does not
permit a partial corpus or an unindexed production launch.

Sources:

- [Qwen3-Embedding model capabilities and benchmark](https://github.com/QwenLM/Qwen3-Embedding)
- [Qwen3-Embedding-8B model card](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- [pgvector HNSW dimension limits](https://github.com/pgvector/pgvector#hnsw)
- [PostgreSQL trusted extension installation](https://www.postgresql.org/docs/current/sql-createextension.html)
- [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html)

## Code Changes

### 1. Ingestion represents the complete Git tree

In `services/bumba/src/event-consumer.ts` and `services/bumba/src/activities/index.ts`:

- Accept only pushes to the configured default branch.
- Treat the event's `after` commit as traceability, then fetch and resolve the exact current `origin/main` commit and
  enumerate its complete tree.
- Apply one versioned eligibility filter.
- Diff eligible Git paths against `atlas.file_keys`.
- Add new paths, replace changed file versions, leave unchanged paths alone, and delete removed `file_keys` rows.
- Treat renames as delete plus add.
- Never update `repositories.default_ref` from an event.
- Bind metadata as JSON objects or explicitly cast serialized text to `jsonb`; verify `jsonb_typeof(...) = 'object'`.
- Mark an event processed only after its required ingestion work is terminal.

Reconciliation is a bounded, resumable mutation of the one existing corpus:

1. Fence the repository with a unique build ID and target commit, set `indexStatus=building`, materialize the exact
   `file_keys` manifest, and make every reader fail closed.
2. Prepare at most `BUMBA_ATLAS_PREPARE_CONCURRENCY` files at once and commit each bounded file/chunk/embedding batch to
   the existing tables. Never retain the whole repository's vectors in worker memory.
3. Heartbeat Temporal every 15 seconds with the build ID, commit, and persisted progress under a 90-second heartbeat
   timeout. A replacement activity reuses that state and the already committed batches.
4. Serialize GitHub events per repository and reject a second writer while the live database lease belongs to another
   build. Manual, UI, and event starts use one repository-scoped Temporal workflow ID so a duplicate active rebuild is
   rejected before it can become another activity.
5. In the final transaction, update unchanged versions to the target commit, verify the entire manifest and embedding
   coverage, and only then publish `indexStatus=ready` plus the canonical configuration.

A failure may leave bounded partial rows in the same disposable schema, but search remains unavailable and the next
idempotent reconciliation resumes or replaces them. There is no old corpus kept online and nothing to restore.

### 2. Chunking covers the source

In `services/bumba/src/activities/index.ts`:

- Recognize exported variables, arrow functions, functions, classes, interfaces, types, methods, and assignments.
- Add overlapping line windows for every region not covered by syntax chunks.
- Assert that every eligible nonblank line belongs to at least one chunk.
- Replace the complete chunk set when a file changes.

Regression fixtures must include `export const createAtlasCodeSearchHandlers = ...`.

### 3. Search uses the entire current corpus

In `services/jangar/src/server/atlas-code-search.ts`:

1. Search exact path and exact identifier matches.
2. Search lexical full text and trigram matches.
3. Search all current chunk embeddings through HNSW.
4. Merge and deduplicate the ranked results.

Remove the `created_at DESC LIMIT 100` candidate query. Search joins only the one current file version for each
`file_key`.

MCP `atlas_code_search`, `POST /api/code-search`, and the `GET /api/search` UI compatibility route all use this same
implementation. Remove the MCP enrichment-search tool, direct index tool, partial backfill CLI, and legacy search CLI so
agents and operators cannot accidentally select a second search or write path.

Embed queries as instructed Qwen inputs:

```text
Instruct: Given a query, retrieve relevant source-code chunks from the repository
Query: <query>
```

Embed chunk documents without the query instruction. Qwen reports a typical 1% to 5% retrieval improvement from task
instructions; the current search embeds the raw query and misses that supported behavior. Use only the Atlas-specific
1,024-dimensional configuration for both sides. If embedding generation fails for any eligible chunk, Atlas remains not
ready. Do not silently fall back while reporting success.

### 4. Results and health tell the truth

- Every response includes repository, `main`, indexed commit, path, lines, file hash, retrieval mode, and degradation.
- Source preview uses `git show <indexedCommit>:<path>` and verifies the content hash.
- Repository metadata has only four states: `maintenance`, `building`, `ready`, and `failed`.
- Search is available only in `ready`.
- Health reports the stored commit, Git head, expected files, indexed files, missing paths, stale paths, chunk coverage,
  embedding coverage, and last error.
- A reconciliation command computes those values from the complete Git tree and database; request handlers never sample
  rows or run unbounded counts.

### 5. Timeouts cancel work

- Set PostgreSQL `statement_timeout` below the API deadline.
- Give cold exact and lexical SQL a five-second failure-isolation ceiling while independently enforcing the one-second
  p95 and two-second p99 acceptance gates. A latency SLO is not a statement timeout.
- Propagate request cancellation to the SQL client.
- Cancel on disconnect.
- Test that the backend query disappears from `pg_stat_activity` within one second.

## Tests That Must Exist Before Truncation

Use a temporary Git repository and real PostgreSQL/pgvector integration database.

1. Initial tree: every eligible path and hash is indexed.
2. Modification: the old file version, chunks, and embeddings disappear.
3. Deletion: the path and all dependent artifacts disappear.
4. Rename: the old path disappears and the new path appears.
5. Duplicate and out-of-order events converge to the newest exact tree.
6. Branch pushes do not affect the `main` corpus or default ref.
7. Exported-arrow identifiers are returned first for exact search.
8. A fixed set of conceptual queries, including natural-language and exact-identifier cases, returns the expected files
   in the top ten with the 1,024-dimensional instructed-query configuration.
9. A deleted-file query returns nothing.
10. Source preview commit and hash match the result.
11. Metadata is a JSON object in PostgreSQL.
12. A timed-out search cancels its database query.
13. A forced embedding failure after one committed batch leaves Atlas unavailable, then a retry resumes from heartbeat
    state and converges without a second schema.
14. Worker startup stays unready until its exact Temporal Worker Deployment build is current and routing propagation is
    `COMPLETED`.

Add one command, `atlas:verify`, that runs the tree/path/hash audit and the fixed query set. Agents and operators use the
same command; there is no separate proof path.

## Implementation and Rollout

The initial writer, schema, reader, and verification repair landed together in PR #12459. The first production rebuild
then exposed an OOM/heartbeat defect that local fixtures had not modeled, so the observed failure is addressed in one
coherent hardening PR before another live rebuild. Do not split a writer change from its recovery, reader, or proof
contract.

1. Implement the code changes, migration, regression tests, `atlas:rebuild`, and `atlas:verify`.
2. Pass focused Bumba/Jangar tests, real PostgreSQL integration tests, and CI.
3. Let Jangar install the trusted `pg_trgm` extension idempotently as the application database owner before it validates
   extensions and runs migrations. New clusters also install it through `postInitApplicationSQL`.
4. Merge, publish the images, and let GitOps deploy maintenance mode. The Bumba Deployment is an earlier Argo sync wave,
   so the disabled event consumer must become healthy before Jangar can apply the destructive migration.
5. Confirm `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED=false` in the live Bumba pod.
6. Let the Jangar migration truncate the Git-derived rows under `atlas.file_keys` and `atlas.symbols`, preserve repository
   identities plus webhook/ingestion history, change the empty embedding column to `vector(1024)`, and create the unique,
   trigram, and HNSW indexes.
7. Run `bun run atlas:rebuild --repository proompteng/lab --ref main` against the exact current `origin/main` commit.
8. Run `bun run atlas:verify` with the live database URL and Jangar base URL.
9. Reconcile and verify once more if `origin/main` advanced during the rebuild.
10. Change the same Bumba Deployment to `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED=true`, merge through GitOps, and prove the
    consumer is live and the indexed commit converges after one subsequent `main` change.

If anything fails after truncation, Atlas stays in maintenance, the defect is fixed, and the idempotent rebuild resumes.
There is nothing to restore.

### Execution record: 2026-07-14

- PR #12459 merged the initial repair; Jangar and Bumba images were promoted, the existing schema migration ran, the
  derived corpus was truncated, and the one Bumba event consumer remained disabled.
- The first live rebuild resolved 8,255 eligible files but was not accepted: Bumba accumulated prepared embeddings in
  memory, was OOM-killed after about 3,600 files, and the activity lacked a heartbeat timeout, so Temporal continued to
  report the dead attempt as running.
- That workflow was terminated. It is failure evidence, not a successful rebuild.
- The hardening described above bounds memory, persists progress, adds heartbeat recovery, serializes repository events,
  removes remaining public legacy writers/search entrypoints, and makes both Bumba and Jangar wait for exact Temporal
  routing propagation during startup.
- The live worker registry now exposes only reconciliation plus its required ingestion bookkeeping, and manual, UI, and
  event callers share one repository-scoped workflow ID. Local PostgreSQL/pgvector tests prove forced post-batch failure,
  unavailable state, heartbeat resume, complete convergence, HNSW migration, hybrid search, and query cancellation. This
  is pre-merge evidence, not production proof.
- At this checkpoint the Definition of Done remained open pending merge, promotion, and a fresh rebuild. The accepted
  2026-07-17 execution record below closes that initial rollout gate.

### Execution record: 2026-07-17 — accepted

- PR #12665 merged the bounded filtered-semantic and literal-search fix with PostgreSQL/pgvector regression coverage.
  PR #12723 raised the exact/lexical PostgreSQL failure-isolation ceiling to five seconds while retaining verifier SLOs
  of p95 below one second and p99 below two seconds. PR #12726 promoted the resulting Jangar image through GitOps.
- The repair kept one existing Atlas schema and corpus, `vector(1024)`, and the configured
  `qwen3-embedding-saigak:8b` model. It introduced no backup, shadow index, dual write, or fallback corpus.
- On the accepted `b12191e4cff53a5266d4e289e43ecd9ea73620aa` snapshot, `atlas:verify` matched all 8,421 eligible
  Git files and all 74,827 chunks/embeddings. Missing, stale, hash, object, commit, line-coverage, embedding, and chunk
  metadata mismatches were all zero.
- Exact identifier search ranked the definition first. The filtered cold semantic fixture ranked
  `docs/atlas/production-code-search-design.md` first, returned ten results, and reported no degradation. Deleted paths
  returned no results, and every sampled source preview matched the indexed commit and content hash.
- The 24-request cold-unique-query performance probe passed below its one-second p95 and two-second p99 limits. The
  cancellation probe reached PostgreSQL and left zero queries running after client cancellation.
- Argo reported Jangar and Bumba `Synced` and `Healthy`; the running Jangar image matched the promoted digest. Exactly
  one Bumba Deployment replica ran with `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED=true`, and the accepted snapshot had no
  running reconcile workflow, unprocessed event, or unfinished ingestion.
- During the final audit, `origin/main` advanced to `d2ffb65c8b773e54189f6a6ff5fc924b0b2d7db3`. The existing
  consumer started the single reconcile without operator duplication and completed in 1 minute 58 seconds. A fresh
  verifier run then matched 8,426/8,426 files and 74,946/74,946 chunks/embeddings with zero integrity errors, p95
  626 ms, p99 640 ms, and zero lingering canceled queries.
- A separately issued cold semantic paraphrase that had no verbatim repository match returned
  `services/bumba/src/atlas/file-eligibility.ts` first in 1.72 seconds with `retrievalMode=semantic` and
  `degradation=null`. This proves the live non-fixture path without adding that query text to the indexed gold set.
- This record closes initial production acceptance, not permanent trust. A later Git/index mismatch, timeout, stale
  path, semantic degradation, or relevance contradiction reopens the gate until the single reconcile and full verifier
  pass on the new active snapshot.

## Definition of Done

Atlas works only when all of these pass on the live indexed commit:

- Eligible Git path count equals `atlas.file_keys` count.
- Missing paths: zero.
- Stale paths: zero.
- File hash mismatches: zero.
- Uncovered eligible nonblank lines: zero.
- Chunks without the configured embedding: zero.
- Exact identifier fixtures return the expected file first.
- Every fixed conceptual query returns its expected file in the top ten.
- Deleted paths never appear.
- Source preview commit and hash match every sampled result.
- Search p95 is below one second and p99 below two seconds under representative concurrency.
- Search produces no 504s, and canceled queries leave PostgreSQL within one second.
- The indexed commit reaches the observed `origin/main` commit within ten minutes.
- No processed event has unfinished required ingestion work.
- Live image digests, Argo state, repository metadata, `atlas:verify`, and the current Git commit agree.

No percentage-based partial coverage is accepted. No fallback mode is called healthy.

## Agent Rule

Agents may use Atlas as the production navigation surface only while the live indexed commit matches the requested Git
ref and the response reports no degradation. Verify high-impact findings against the returned exact commit. A miss,
stale path, wrong commit, timeout, or irrelevant lexical fallback is contradictory live evidence: report it and reopen
the verification gate instead of hiding it with a narrower query.

## Code Map

- Search: `../../services/jangar/src/server/atlas-code-search.ts`
- Search configuration: `../../services/jangar/src/server/memory-config.ts`
- Schema: `../../services/jangar/src/server/migrations/20251228_init.ts`
- Chunk embeddings: `../../services/jangar/src/server/migrations/20260209_atlas_chunk_search.ts`
- Current-corpus migration: `../../services/jangar/src/server/migrations/20260714_atlas_current_corpus.ts`
- Source preview: `../../services/jangar/src/routes/api/atlas/file.ts`
- Ingestion and chunking: `../../services/bumba/src/activities/index.ts`
- Eligibility: `../../services/bumba/src/atlas/file-eligibility.ts`
- Reconciliation planner: `../../services/bumba/src/atlas/reconciliation.ts`
- GitHub events: `../../services/bumba/src/event-consumer.ts`
- Rebuild command: `../../packages/scripts/src/atlas/rebuild.ts`
- Verification command: `../../packages/scripts/src/atlas/verify.ts`
- Fixed query set: `query-gold-set.json`
- PostgreSQL: `../../argocd/applications/jangar/postgres-cluster.yaml`
