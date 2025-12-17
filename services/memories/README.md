# memories

This directory hosts a small Bun service that backs Codex memory storage and retrieval.

Note: this service is intended for local/dev agents. Production deployments should use Jangar's MCP memories storage (`services/jangar`) instead.

## Setup

```bash
bun install
```

### Local Postgres

Bootstrapping the local Postgres schema creates a dedicated `cerebrum` role and database. Run:

```bash
bun run createdb
```

The script checks for `cerebrum` before creating the role/database and leaves the password set to `cerebrum` so the bundled helpers can connect locally.

Set `DATABASE_URL` to `postgres://cerebrum:cerebrum@localhost:5432/cerebrum?sslmode=disable` (see `.env.example`) when working locally.

### Required environment

- `DATABASE_URL` – Postgres (pgvector-enabled) endpoint with the `memories` schema.
- `OPENAI_API_KEY` – key used for the embedding API calls.
- `OPENAI_EMBEDDING_MODEL` – optional (defaults to `text-embedding-3-small`).
- `OPENAI_EMBEDDING_DIMENSION` – optional (defaults to `1536`).
- `OPENAI_API_BASE_URL` – optional (defaults to `https://api.openai.com/v1`).

## Scripts

### Save a memory

```bash
bun run save-memory --task-name "describe repo" --content "we changed X" \
  --summary "repo update" --tags task,repo --metadata '{"team":"architect"}'
```

- `--content` or `--content-file` – the block of text that will be embedded and stored.
- `--task-name` – human-readable identifier (required).
- `--summary` – short overview (defaults to the first 300 characters of content).
- `--description` – optional longer task description.
- `--repository-ref`, `--repository-commit`, `--repository-path`, `--execution-id` – provenance.
- `--tags` – comma-separated list; stored as a `text[]`.
- `--metadata` – JSON string stored under `metadata`.
- `--model` – overrides `OPENAI_EMBEDDING_MODEL`.

### Retrieve memories

```bash
bun run retrieve-memory --query "what did we build" --limit 5
```

- `--query` or `--query-file` – the prompt used to search the vector store.
- `--model` – overrides the embedding model (ensure dimension matches `OPENAI_EMBEDDING_DIMENSION`).
- `--repository-ref`, `--source`, `--task-name`, `--tags` – filters to restrict the search.
- `--limit` – up to how many matches to return (defaults to `5`).

## Testing

```bash
bun test tests
```

## Database client

`save-memory` and `retrieve-memory` both use Bun's built-in `SQL` client (`new SQL(DATABASE_URL)`), so there is no additional Postgres driver dependency to manage.

## Database schema

Apply `schemas/embeddings/memories.sql` against the target Postgres database to create the `memories` schema, entries table, event log, and indexes (it also enables the `vector` extension).
