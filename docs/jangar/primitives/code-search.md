# Code Search Primitive (Atlas)

Status: Current implementation contract. Live trust remains gated by the Definition of Done in
[`docs/atlas/production-code-search-design.md`](../../atlas/production-code-search-design.md).

## Purpose

Atlas gives agents reproducible source-code pointers from one exact `proompteng/lab` `main` snapshot. It supports
intent, identifier, path, and lexical retrieval while preserving commit, path, line, and content-hash provenance.

Atlas is a Git-derived cache, not a narrative memory store and not a source of truth. Material findings must be opened
from the returned commit.

## Runtime Contract

- PostgreSQL database: Jangar application database.
- Schema: the existing `atlas` schema.
- Source ref: only `main`.
- Writer: Bumba workflow `reconcileAtlasRepository`.
- Reader: `services/jangar/src/server/atlas-code-search.ts`.
- Embedding model: `qwen3-embedding-saigak:8b`.
- Atlas embedding output: 1,024 dimensions.
- Search availability: only when the complete stored corpus is `ready` and its configuration and counts agree.

Bumba reconciles the complete `origin/main` tree in bounded, persisted batches. Temporal heartbeat state and a database
build lease make the one writer resumable and fenced. It does not accept partial file lists as corpus authority, and it
does not keep another schema online. See [`docs/atlas-indexing.md`](../../atlas-indexing.md) for the data-flow contract.

## Retrieval Contract

The single Jangar implementation searches all current chunks with four signals:

1. exact path and identifier matches;
2. PostgreSQL full-text lexical matches;
3. trigram path and source-content matches;
4. pgvector HNSW cosine matches over 1,024-dimensional chunk embeddings.

It merges and deduplicates those candidates. Every result includes:

- repository and ref;
- exact indexed commit;
- path and source line range;
- file content hash;
- normalized score and contributing signals;
- retrieval mode and explicit degradation state;
- source snippet.

Source preview resolves the returned commit with Git and verifies the content hash. Mutable local `main` is never the
preview authority.

## Supported Interfaces

### MCP

Use `atlas_code_search`:

```json
{
  "query": "where is Temporal worker routing aligned before Bumba readiness",
  "repository": "proompteng/lab",
  "ref": "main",
  "pathPrefix": "services/bumba",
  "language": "typescript",
  "limit": 8
}
```

The only other Atlas MCP operation is read-only `atlas_stats`. There is no MCP index operation or legacy enrichment
search operation.

### HTTP

`POST /api/code-search` is canonical:

```bash
curl -sS -X POST \
  -H 'content-type: application/json' \
  http://localhost:3000/api/code-search \
  -d '{"query":"reconcileAtlasRepository","repository":"proompteng/lab","ref":"main","limit":5}'
```

`GET /api/search` exists only for the Jangar UI and calls the same handler. Legacy enrichment `tags` and `kinds` filters
are rejected instead of selecting a second search system.

### Repository CLI

Agents use the same API through:

```bash
bun run atlas:code-search \
  --query "reconcile complete main tree" \
  --repository proompteng/lab \
  --path-prefix services/bumba \
  --limit 10
```

The command is navigation. Operators use `atlas:rebuild` for the only write path and `atlas:verify` for complete live
proof. Partial backfills and per-file production writers are intentionally absent.

## Failure Semantics

- `maintenance`, `building`, or `failed` corpus state returns service unavailable.
- A stored/model/dimension/count mismatch returns service unavailable.
- Missing query embeddings never produce a falsely healthy semantic result.
- Request deadlines cancel PostgreSQL work rather than leaving it running.
- A stale or unavailable Git commit makes source preview fail closed.

No interface may silently search an old corpus, downgrade to a different search implementation, or report readiness
from a sample.

## Agent Workflow

1. Search with repository and a useful path prefix when known.
2. Open the returned exact commit and line range.
3. Treat a miss for a known current symbol, a deleted/stale path, a commit mismatch, or semantic degradation as an Atlas
   defect and report it.
4. Until the production live gates pass, do not use Atlas health or plausible results as corpus-completeness proof.
