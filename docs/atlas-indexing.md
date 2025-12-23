# Atlas Indexing & Semantic Search (Design Doc)

## Summary

This document defines the `atlas` schema and indexing pipeline for file‑level semantic search. The goal is a generic, agent‑friendly retrieval layer that can index code files (and derived context like AST facts and model summaries) and serve fast semantic queries.

## Goals

- Provide a dedicated, Jangar‑owned schema (`atlas`) for code indexing and retrieval.
- Support multi‑source enrichments (AST facts, summaries, notes, etc.).
- Enable fast semantic search with filtering by repo/ref/path/tags.
- Keep ingestion flexible (Temporal workflows + reusable activities).
- Expose generic REST + MCP endpoints (no service‑specific names).

## Non‑Goals

- Full code graph or cross‑repo dependency graph.
- Replacing `memories` or retrofitting existing memories data.
- Real‑time indexing on every commit (initially on‑demand).

## Architecture Overview

```mermaid
flowchart LR
  UI[Jangar UI] -->|select file| API[Jangar REST + MCP]
  API --> TC[Temporal Client]
  TC --> WF[bumba workflow]
  WF --> ACT1[Read file + metadata]
  WF --> ACT2[AST‑grep extraction]
  WF --> ACT3[Model enrichment]
  WF --> ACT4[Embedding]
  ACT4 --> DB[(Postgres: atlas schema)]
  API --> DB
```

## Data Model (atlas schema)

### Entities

- `repositories`: tracked repos + default refs.
- `files`: file versions (ref/commit/path/hash).
- `file_chunks`: optional chunk records (future‑proofing).
- `enrichments`: semantic units (summary, AST facts, completion notes).
- `embeddings`: vector storage by model + dimension.
- `ast_grep_facts`: structured AST matches.

```mermaid
erDiagram
  REPOSITORIES ||--o{ FILES : contains
  FILES ||--o{ FILE_CHUNKS : splits
  FILES ||--o{ ENRICHMENTS : has
  FILE_CHUNKS ||--o{ ENRICHMENTS : has
  ENRICHMENTS ||--o{ EMBEDDINGS : embeds
  FILES ||--o{ AST_GREP_FACTS : matches

  REPOSITORIES {
    uuid id
    text name
    text default_ref
    jsonb metadata
    timestamptz created_at
    timestamptz updated_at
  }

  FILES {
    uuid id
    uuid repository_id
    text repository_ref
    text repository_commit
    text path
    text content_hash
    text language
    int byte_size
    int line_count
    jsonb metadata
    timestamptz created_at
    timestamptz updated_at
  }

  FILE_CHUNKS {
    uuid id
    uuid file_id
    int chunk_index
    int start_line
    int end_line
    text content
    int token_count
    jsonb metadata
    timestamptz created_at
  }

  ENRICHMENTS {
    uuid id
    uuid file_id
    uuid chunk_id
    text kind
    text source
    text content
    text summary
    text[] tags
    jsonb metadata
    timestamptz created_at
  }

  EMBEDDINGS {
    uuid id
    uuid enrichment_id
    text model
    int dimension
    vector embedding
    timestamptz created_at
  }

  AST_GREP_FACTS {
    uuid id
    uuid file_id
    text rule_id
    text match_text
    int start_line
    int end_line
    jsonb metadata
    timestamptz created_at
  }
```

### Indexing Strategy

- `atlas.files`:
  - `path` index for prefix searches.
  - `(repository_ref, repository_commit)` for exact snapshots.
  - GIN index on `metadata` for filters.
- `atlas.enrichments`:
  - `kind`, `tags`, `metadata` indexes for filtering.
- `atlas.embeddings`:
  - IVF‑Flat index on `embedding` with cosine ops.

### Embedding Dimension

The `embedding` column uses a fixed dimension from `OPENAI_EMBEDDING_DIMENSION`. If the configured dimension changes, a migration or regeneration is required.

## Ingestion Workflow (bumba)

```mermaid
sequenceDiagram
  participant UI as Jangar UI
  participant API as Jangar API
  participant TC as Temporal Client
  participant WF as bumba Workflow
  participant ACT as Activities
  participant DB as Postgres (atlas)

  UI->>API: POST /api/enrich {file}
  API->>TC: Start workflow (file payload)
  TC->>WF: bumbaEnrichFile
  WF->>ACT: Read file + metadata
  WF->>ACT: Run AST‑grep rules
  WF->>ACT: Call model (completion)
  WF->>ACT: Create embeddings
  ACT->>DB: Upsert repository, file, enrichment, embedding
  API-->>UI: 202 Accepted + workflow id
```

## API Surface (generic)

### REST

- `POST /api/enrich`
  - Input: `{ repository, ref, commit?, path, contentHash?, metadata? }`
  - Returns: workflow id or indexing result.
- `GET /api/search`
  - Input: `query`, `limit`, optional `repository`, `ref`, `pathPrefix`, `tags[]`, `kinds[]`.
  - Returns: ranked enrichment results + file metadata.

### MCP

- `semantic.index`
- `semantic.search`
- `semantic.stats`

## Operational Considerations

- Schema and extensions are created lazily on first use.
- Embedding dimension mismatch causes a clear error until migrated.
- Index build uses `ivfflat` lists = 100 (tunable).
- Bumba workflows are reusable and activity‑based for future pipelines.

## Security Notes

- All indexing is scoped to known repo mounts (Jangar PVC).
- Embedding calls use OpenAI‑compatible endpoints (self‑hosted on `190`).
- Inputs are normalized and size‑bounded to avoid model abuse.

## Open Questions

- Whether to chunk files immediately or only when size exceeds a threshold.
- Backfill policy from existing `memories` content (likely no).
- How to version AST‑grep rules and link them in metadata.
