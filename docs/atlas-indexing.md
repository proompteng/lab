# Atlas Indexing & Semantic Search (Design Doc)

## Summary

This document defines the `atlas` schema and indexing pipeline for file‑level semantic search. The goal is a generic, agent‑friendly retrieval layer that can index code files (and derived context like AST facts and model summaries) and serve fast semantic queries.

## Goals

- Provide a dedicated, Jangar‑owned schema (`atlas`) for code indexing and retrieval.
- Support multi‑source enrichments (AST facts, summaries, notes, etc.).
- Enable fast semantic search with filtering by repo/ref/path/tags.
- Keep ingestion flexible (Temporal workflows + reusable activities).
- Expose generic REST + MCP endpoints (no service‑specific names).
- Ensure webhook‑driven workflows are idempotent and safe to retry.

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
  WF --> ACT2[Tree‑sitter extraction]
  WF --> ACT3[Model enrichment]
  WF --> ACT4[Embedding]
  ACT4 --> DB[(Postgres: atlas schema)]
  API --> DB
```

## Data Model (atlas schema)

### Entities

- `repositories`: tracked repos + default refs.
- `file_keys`: stable file identity per repo+path.
- `file_versions`: versioned snapshots (ref/commit/hash).
- `file_chunks`: optional chunk records (future‑proofing).
- `enrichments`: semantic units (summary, AST facts, completion notes).
- `embeddings`: vector storage by model + dimension.
- `tree_sitter_facts`: structured AST matches.
- `symbols` + `symbol_defs` + `symbol_refs`: cross‑file definition/reference graph.
- `file_edges`: explicit file‑to‑file relationships for traversal.
- `github_events`: webhook delivery log for idempotency.
- `ingestions`: workflow runs tied to webhook events.
- `event_files`: map webhook events to file keys.
- `ingestion_targets`: map workflow runs to indexed file versions.

```mermaid
erDiagram
  REPOSITORIES ||--o{ FILE_KEYS : contains
  FILE_KEYS ||--o{ FILE_VERSIONS : versions
  FILE_VERSIONS ||--o{ FILE_CHUNKS : splits
  FILE_VERSIONS ||--o{ ENRICHMENTS : has
  FILE_CHUNKS ||--o{ ENRICHMENTS : has
  ENRICHMENTS ||--o{ EMBEDDINGS : embeds
  FILE_VERSIONS ||--o{ TREE_SITTER_FACTS : matches
  REPOSITORIES ||--o{ SYMBOLS : owns
  SYMBOLS ||--o{ SYMBOL_DEFS : defines
  SYMBOLS ||--o{ SYMBOL_REFS : references
  FILE_VERSIONS ||--o{ SYMBOL_DEFS : in_file
  FILE_VERSIONS ||--o{ SYMBOL_REFS : in_file
  FILE_VERSIONS ||--o{ FILE_EDGES : from_file
  FILE_VERSIONS ||--o{ FILE_EDGES : to_file
  GITHUB_EVENTS ||--o{ INGESTIONS : triggers
  GITHUB_EVENTS ||--o{ EVENT_FILES : touches
  FILE_KEYS ||--o{ EVENT_FILES : file_key
  INGESTIONS ||--o{ INGESTION_TARGETS : indexes
  FILE_VERSIONS ||--o{ INGESTION_TARGETS : file_version

  REPOSITORIES {
    uuid id
    text name
    text default_ref
    jsonb metadata
    timestamptz created_at
    timestamptz updated_at
  }

  FILE_KEYS {
    uuid id
    uuid repository_id
    text path
    timestamptz created_at
  }

  FILE_VERSIONS {
    uuid id
    uuid file_key_id
    text repository_ref
    text repository_commit
    text content_hash
    text language
    int byte_size
    int line_count
    jsonb metadata
    timestamptz source_timestamp
    timestamptz created_at
    timestamptz updated_at
  }

  FILE_CHUNKS {
    uuid id
    uuid file_version_id
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
    uuid file_version_id
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

  TREE_SITTER_FACTS {
    uuid id
    uuid file_version_id
    text node_type
    text match_text
    int start_line
    int end_line
    jsonb metadata
    timestamptz created_at
  }

  SYMBOLS {
    uuid id
    uuid repository_id
    text name
    text normalized_name
    text kind
    text signature
    jsonb metadata
    timestamptz created_at
  }

  SYMBOL_DEFS {
    uuid id
    uuid symbol_id
    uuid file_version_id
    int start_line
    int end_line
    jsonb metadata
    timestamptz created_at
  }

  SYMBOL_REFS {
    uuid id
    uuid symbol_id
    uuid file_version_id
    int start_line
    int end_line
    jsonb metadata
    timestamptz created_at
  }

  FILE_EDGES {
    uuid id
    uuid from_file_version_id
    uuid to_file_version_id
    text kind
    jsonb metadata
    timestamptz created_at
  }

  GITHUB_EVENTS {
    uuid id
    uuid repository_id
    text delivery_id
    text event_type
    text repository
    text installation_id
    text sender_login
    jsonb payload
    timestamptz received_at
    timestamptz processed_at
  }

  INGESTIONS {
    uuid id
    uuid event_id
    text workflow_id
    text status
    text error
    timestamptz started_at
    timestamptz finished_at
  }

  EVENT_FILES {
    uuid id
    uuid event_id
    uuid file_key_id
    text change_type
  }

  INGESTION_TARGETS {
    uuid id
    uuid ingestion_id
    uuid file_version_id
    text kind
  }
```

### Indexing Strategy

- `atlas.file_keys` + `atlas.file_versions`:
  - `path` index for prefix searches.
  - `(repository_ref, repository_commit)` for exact snapshots.
  - GIN index on `metadata` for filters.
- `atlas.enrichments`:
  - `kind`, `tags`, `metadata` indexes for filtering.
- `atlas.embeddings`:
  - IVF‑Flat index on `embedding` with cosine ops.
- `atlas.symbols` + `atlas.symbol_defs` + `atlas.symbol_refs`:
  - `normalized_name` + `kind` for symbol lookups.
  - `file_version_id` for traversal from a file.
- `atlas.file_edges`:
  - `(from_file_version_id, kind)` and `(to_file_version_id, kind)` for graph traversal.

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
  TC->>WF: enrichFile
  WF->>ACT: Read file + metadata
  WF->>ACT: Extract Tree‑sitter facts
  WF->>ACT: Call model (completion)
  WF->>ACT: Create embeddings
  ACT->>DB: Upsert repository, file_key, file_version, enrichment, embedding
  ACT->>DB: Record webhook event + ingestion status (idempotent)
  ACT->>DB: Record event_files + ingestion_targets for file traceability
  API-->>UI: 202 Accepted + workflow id
```

### Ingestion Tracking Details

- Jangar records webhook deliveries in `atlas.github_events` and starts workflows with the actual Temporal workflow ID.
- Bumba workflows create or update `atlas.ingestions` using that workflow ID and the GitHub delivery id.
- `atlas.ingestions.status` is updated to `running` → `completed` (or `failed`/`skipped`) by the workflow itself.
- `atlas.event_files` is populated when a file is indexed, keyed to the webhook delivery id + file key.
- `atlas.ingestion_targets` is populated for each indexed file version with `kind = model_enrichment`.

These links allow full traceability from webhook event → workflow run → file keys → file versions.

### Data Quality Guardrails

- Repository refs are normalized before persistence (e.g., `refs/heads/main` → `main`) to avoid duplicate file_versions.
- When Tree‑sitter yields no interesting nodes, facts fall back to a plain‑text parser so `tree_sitter_facts` isn’t empty for simple formats (e.g., JSON).

## API Surface (generic)

### REST

- `POST /api/enrich`
  - Input: `{ repository, ref, commit?, path, contentHash?, metadata? }`
  - Returns: workflow id or indexing result.
- `GET /api/search`
  - Input: `query`, `limit`, optional `repository`, `ref`, `pathPrefix`, `tags[]`, `kinds[]`.
  - Returns: ranked enrichment results + file metadata.

### MCP

- `atlas.index`
- `atlas.search`
- `atlas.stats`

## Operational Considerations

- Schema and extensions are created lazily on first use.
- Embedding dimension mismatch causes a clear error until migrated.
- Index build uses `ivfflat` lists = 100 (tunable).
- Bumba workflows are reusable and activity‑based for future pipelines.
- Webhook deliveries are idempotent via `github_events.delivery_id` and `ingestions` records.
- Index updates are idempotent by `(file_key_id, repository_ref, repository_commit, content_hash)`.
- Event and ingestion link tables provide traceability from webhook → files → indexed versions.
- Graph traversal is supported by `symbol_defs`/`symbol_refs` (for symbol‑level joins) and `file_edges` (for direct file‑to‑file edges).

## Security Notes

- All indexing is scoped to known repo mounts (Jangar PVC).
- Embedding calls use OpenAI‑compatible endpoints (self‑hosted on `190`).
- Inputs are normalized and size‑bounded to avoid model abuse.

## Open Questions

- Whether to chunk files immediately or only when size exceeds a threshold.
- Backfill policy from existing `memories` content (likely no).
- How to version Tree‑sitter grammars or extraction rules and link them in metadata.
- How to normalize symbols consistently across languages (e.g., module‑qualified names).

## Implementation Task Slices (Argo/Codex)

Use these slices to create one GitHub issue per task (Codex workflow friendly).

1) Atlas schema + Jangar store layer  
   - Scope: create `atlas` schema and Jangar store/service.  
   - Touch: `services/jangar/src/server/atlas-store.ts`, `services/jangar/src/server/atlas.ts`, tests.  
   - Output: auto‑create tables + idempotent upserts.

2) REST + MCP endpoints (generic)  
   - Scope: `POST /api/enrich`, `GET /api/search`, MCP tools `atlas.index|search|stats`.  
   - Touch: `services/jangar/src/routes/api/enrich.ts`, `services/jangar/src/routes/api/search.ts`, MCP handler.  
   - Depends on: task 1 interface.

3) Bumba workflow activities (Tree‑sitter + model + embedding)  
   - Scope: workflow activities + idempotent orchestration.  
   - Touch: `services/bumba/src/activities/*`, `services/bumba/src/workflows/index.ts`.  
   - Depends on: task 1 schema.

4) Jangar UI + sidebar entry  
   - Scope: atlas page with indexed file table + search + enrich trigger.  
   - Touch: `services/jangar/src/components/app-sidebar.tsx`, `services/jangar/src/routes/atlas.tsx`.  
   - Depends on: task 2 endpoints.

5) Script helpers for agents  
   - Scope: bun script that queries `/api/search`.  
   - Touch: `packages/scripts/src/atlas/search.ts`, root script `atlas:search`.  
   - Depends on: task 2 endpoints.

6) Froussard webhook integration  
   - Scope: GitHub webhook -> `/api/enrich` with idempotency.  
   - Touch: `services/froussard/**`.  
   - Depends on: task 2 endpoints + atlas event tables.

## Tree‑sitter Extraction (per file)

We normalize Tree‑sitter output into a stable facts schema:

- Parse file with the language grammar.
- Walk the AST and emit facts like `{ node_type, match_text, start_line, end_line, metadata }`.
- Store those facts in `atlas.tree_sitter_facts` and/or append to `enrichments` metadata.
- Emit symbols + refs + file edges for cross‑file navigation.

Pseudocode example (activity):

```ts
const parser = new Parser()
parser.setLanguage(lang)
const tree = parser.parse(source)
const facts = []
walk(tree.rootNode, (node) => {
  if (isInteresting(node)) {
    facts.push({
      node_type: node.type,
      match_text: source.slice(node.startIndex, node.endIndex),
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      metadata: { field: node.fieldName },
    })
  }
  if (isSymbolDef(node)) {
    emitSymbolDef(node)
  }
  if (isSymbolRef(node)) {
    emitSymbolRef(node)
  }
  if (isImportEdge(node)) {
    emitFileEdge(node)
  }
})
```
