# Code Search Primitive (Atlas)

## Purpose

The Code Search primitive provides a durable, queryable index over one or more Git repositories so agents can:

- Find the right code to read or modify (with precise file + line pointers).
- Search by intent (semantic) and by identifiers (lexical) with strong recall.
- Filter results by repo/ref/path/language and remain access-controlled by Jangar.

Jangar is the control plane for all Code Search resources and APIs.

## Grounding In The Current Platform (As Of 2026-02-09)

This repository already has an Atlas-backed indexing pipeline that writes into the `jangar-db` CNPG cluster:

- CNPG cluster: `jangar/jangar-db` (Postgres 17, healthy)
- Database: `jangar`
- Schema: `atlas`

Observed table state:

- `atlas.file_versions`: ~24.9k rows
- `atlas.enrichments` (`kind=model_enrichment`): ~19.3k rows
- `atlas.embeddings`: ~19.2k rows (dominantly `qwen3-embedding-saigak:0.6b`, 1024d)
- `atlas.tree_sitter_facts`: ~1.78M rows
- `atlas.file_chunks`: 0 rows (exists but not used yet)

Implication:

- Today, semantic search is effectively file-level (embedding/enrichment per file), not function/class-level.
- Tree-sitter facts are available and can be leveraged to produce stable, syntax-aware chunks.

Related design doc (existing): `docs/atlas-indexing.md`

## Goals

- Add chunk-level indexing (functions/classes/config blocks) while preserving existing file-level indexing.
- Provide a single agent-friendly API for retrieval with stable pointers (`path`, `commit`, `start_line`, `end_line`).
- Implement hybrid retrieval (vector + lexical) with predictable filtering and access control.
- Support incremental updates (webhooks/changed files) and backfills (full repository refs).
- Keep model-heavy work isolated from the rest of the platform (dedicated workers/task queues).

## Non-Goals

- A full cross-repo dependency graph (nice-to-have, not required for search MVP).
- Replacing memories; code search is a retrieval tool, not a durable narrative store.
- Perfect reranking on day 1; start with hybrid recall + heuristic rerank, then iterate.

## Primitive Contract

### CodeIndex (claim)

Namespace-scoped claim for an indexed codebase. This is a platform primitive like Memory/Agent/Orchestration.

```yaml
apiVersion: atlas.proompteng.ai/v1alpha1
kind: CodeIndex
metadata:
  name: lab-main
  namespace: jangar
spec:
  providerRef:
    name: postgres-default
  repository:
    nameWithOwner: proompteng/lab
  ref:
    type: branch
    name: main
  indexing:
    mode: incremental
    chunking:
      enabled: true
      strategy: tree-sitter
      fallback:
        type: fixed_lines
        linesPerChunk: 80
    embeddings:
      enabled: true
      model: qwen3-embedding-saigak:0.6b
      dimension: 1024
    lexical:
      enabled: true
      tokenizer: postgres_tsvector
  access:
    readerRole: atlas_reader
    writerRole: atlas_writer
```

Notes:

- `providerRef` keeps the primitive provider-decoupled. The first provider is Postgres/pgvector in `jangar-db`.
- `ref` must support both “main branch” and “commit SHA” indexing. Agents frequently need commit-specific retrieval.

### CodeIndexStore (internal)

Composite/internal resource binding the claim to a concrete provider dataset (similar to `MemoryStore`).

## Data Model

See `docs/atlas-indexing.md` for the baseline schema. This document focuses on the delta required to make the index
agent-grade.

### Current Model (Already In Use)

- `file_versions`: versioned snapshots keyed by repo ref + commit + hash.
- `enrichments`: model output per file version.
- `embeddings`: vector embeddings attached to enrichments.
- `tree_sitter_facts`: structured AST matches (high volume).

### Required Additions For Chunk-Level Retrieval

1. Persist chunks into `atlas.file_chunks`.

`atlas.file_chunks` already exists, but currently has 0 rows. The ingestion pipeline should populate it for each
indexed `file_version`.

2. Add chunk-level embeddings.

Add a new table:

```sql
-- New table (recommended) to avoid overloading atlas.embeddings with mixed identity types.
CREATE TABLE atlas.chunk_embeddings (
  chunk_id uuid PRIMARY KEY REFERENCES atlas.file_chunks(id) ON DELETE CASCADE,
  model text NOT NULL,
  dimension int NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Add a vector index (this repo currently uses `ivfflat`):

```sql
CREATE INDEX atlas_chunk_embeddings_embedding_idx
  ON atlas.chunk_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

3. Add lexical search support for chunks.

Add a `tsvector` column (stored or computed) and a `GIN` index:

```sql
ALTER TABLE atlas.file_chunks
  ADD COLUMN text_tsvector tsvector;

CREATE INDEX file_chunks_text_tsvector_gin
  ON atlas.file_chunks
  USING gin (text_tsvector);
```

Populate `text_tsvector` on write using `to_tsvector('simple', content)` and optionally include symbol names from
metadata.

## Current Implementation (2026-02-09)

This repository now implements the “chunk-level retrieval” parts of this design.

### Jangar API

- HTTP endpoint: `POST /api/code-search`
- MCP tool: `atlas_code_search` (alias: `atlas.code_search`)

The search is hybrid:

- Lexical: `websearch_to_tsquery` + `ts_rank_cd` over `atlas.file_chunks.text_tsvector`
- Semantic: `pgvector` cosine distance over `atlas.chunk_embeddings.embedding`

### Bumba Indexing (Chunk Indexing)

Bumba writes chunks and chunk embeddings as part of the `enrichFile` workflow, after file-level enrichment/embedding
and facts persistence.

Chunk indexing is feature-flagged:

- `BUMBA_ATLAS_CHUNK_INDEXING=true` enables writing to `atlas.file_chunks` and `atlas.chunk_embeddings`.
- When disabled (default), Bumba will return a `{ skipped: true, reason: 'disabled' }` result and continue.

Chunk extraction tuning env vars (defaults in code):

- `BUMBA_ATLAS_CHUNK_LINES` (default 80)
- `BUMBA_ATLAS_MIN_CHUNK_LINES` (default 3)
- `BUMBA_ATLAS_MAX_CHUNK_LINES` (default 220)
- `BUMBA_ATLAS_MAX_CHUNKS` (default 250)

## Agent Usage

Agents should treat Code Search like “Memories, but for code pointers”: use it to find the right place to read/edit,
then fetch the exact file content using existing file-read primitives.

### MCP: `atlas_code_search`

Input:

```json
{
  "query": "where do we set the bumba Temporal model task queue?",
  "repository": "proompteng/lab",
  "ref": "main",
  "pathPrefix": "services/bumba",
  "limit": 8
}
```

Output matches include:

- `repository`, `ref`, `commit`
- `path`
- `startLine`, `endLine`
- `score` (normalized hybrid score)
- `highlights` (optional short snippets)

Workflow:

1. Call `atlas_code_search` with a specific query and `pathPrefix` whenever possible.
2. Open the returned file(s) and read the chunk region (`startLine..endLine`).
3. If results are too broad, re-run with tighter `pathPrefix` or more identifier-heavy queries.

### HTTP: `POST /api/code-search`

Example:

```bash
curl -sS \\
  -X POST \\
  -H 'content-type: application/json' \\
  http://localhost:3000/api/code-search \\
  -d '{\"query\":\"indexFileChunks\",\"repository\":\"proompteng/lab\",\"pathPrefix\":\"services/bumba\",\"limit\":5}'
```

## Ingestion And Freshness

### Incremental indexing (default)

Trigger on GitHub webhook (or equivalent) with a file list:

1. Upsert repository, file key, and file version.
2. Extract tree-sitter facts (already working today).
3. Persist `file_chunks` for the file version (new).
4. Generate:
   - File-level enrichment + embedding (keep existing behavior).
   - Chunk-level embeddings (new).

Idempotency rules:

- Use `file_versions.content_hash` to skip work for unchanged file content.
- Use `(file_version_id, chunk_index)` + a chunk content hash (in `file_chunks.metadata`) to skip chunk recompute.

### Backfill indexing

Backfill is required because `file_chunks` is currently empty. A backfill workflow should:

- Iterate `atlas.file_versions` for `(repo_ref, repo_commit)` pairs.
- Populate chunks and chunk embeddings for each file version.
- Be rate limited by GPU capacity (prefer dedicated task queues/workers).

## Query API (What Agents Use)

Agents should not query Postgres directly. They call Jangar.

### Endpoint

`POST /api/code-search`

Request:

```json
{
  "repository": "proompteng/lab",
  "ref": "main",
  "query": "where is TEMPORAL_TASK_QUEUE set for bumba workers?",
  "filters": {
    "pathPrefix": "argocd/applications/bumba",
    "language": null,
    "chunkType": null
  },
  "k": 12
}
```

Response (shape):

```json
{
  "results": [
    {
      "repository": "proompteng/lab",
      "ref": "main",
      "commit": "91a766394ea8d8469071d8463ec8979f7da80956",
      "path": "argocd/applications/bumba/deployment.yaml",
      "startLine": 35,
      "endLine": 75,
      "symbol": null,
      "score": 0.83,
      "signals": {
        "semanticScore": 0.83,
        "lexicalScore": 0.22,
        "matchedIdentifiers": ["TEMPORAL_TASK_QUEUE"]
      },
      "snippet": "...\n- name: TEMPORAL_TASK_QUEUE\n  value: bumba\n..."
    }
  ]
}
```

### Retrieval algorithm (MVP)

Hybrid retrieval with deterministic filtering:

1. Vector candidates: search `atlas.chunk_embeddings` (and optionally file-level embeddings for fallback).
2. Lexical candidates: search `atlas.file_chunks.text_tsvector`.
3. Merge + rerank:
   - Boost exact identifier hits (from query tokens).
   - Boost path matches if `pathPrefix` is present.
   - Prefer smaller spans (chunk hits) over whole-file hits when scores are similar.

### Access control

- Jangar authorizes `(caller, repository, ref/commit)` before returning any snippet.
- In multi-tenant mode, enforce row-level filtering at query time.

## Agent Usage Guide

### When to use Code Search

- Before changing code, run Code Search to locate the best edit site.
- When asked “where is X implemented?”, start with Code Search, then open the files and read the surrounding context.

### Query tips (practical)

- Include identifiers when you have them: `"TEMPORAL_TASK_QUEUE"` or `enrichWithModel`.
- If you’re not sure, ask conceptually: “where is the Temporal task queue configured for bumba model worker”.
- Use `pathPrefix` early to cut noise when you know the area.

### Minimal agent loop (recommended)

1. `code_search(query, repo, ref, filters)`
2. Open top 3-8 snippets in the workspace.
3. Only then reason/implement changes.

This avoids guessing and reduces the number of “search -> wrong file -> search again” cycles.

## Operational Notes

- Keep model-heavy enrichment isolated (dedicated workers/task queues). Do not let model latency starve the rest of
  the indexing pipeline.
- Track:
  - ingestion backlog by task queue
  - embedding latency p50/p95
  - query latency p50/p95
  - recall proxies (how often agents open top-k results)
- Backfills should be throttled; start with 1 embedding worker and scale cautiously.

## Debugging With kubectl + CNPG (Current State)

List top atlas tables:

````bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c \\\n  \"SELECT nspname AS schema, relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size\\\n   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace\\\n   WHERE c.relkind='r' AND nspname NOT IN ('pg_catalog','information_schema')\\\n   ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30;\"\n```

Check whether chunk indexing is enabled (it is not today):

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c \\\n  \"SELECT count(*) FROM atlas.file_chunks;\"\n```

## Rollout Plan (Recommended)

1. Ship schema changes (chunk embeddings + tsvector) behind a feature flag.
2. Update ingestion to write `atlas.file_chunks` and `atlas.chunk_embeddings` for new ingestions.
3. Enable the Code Search API endpoint (hybrid retrieval) and integrate it as an agent tool.
4. Backfill existing `file_versions` with rate limiting.
5. Iterate on chunking and reranking based on real agent usage.
````
