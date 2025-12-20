# memories

This directory hosts a small Bun service that backs Codex memory storage and retrieval.

Note: this service is intended for local/dev agents. Production deployments should use Jangar's MCP memories storage (`services/jangar`) instead.

## Setup

```bash
bun install
```

### Kubernetes Postgres (Jangar)

By default the `save-memory` and `retrieve-memory` helpers connect to the Jangar Postgres cluster by:

- reading the connection URI from the `jangar-db-app` secret in your current kubectl namespace (override with `MEMORIES_KUBE_NAMESPACE`)
- starting a `kubectl port-forward` to `svc/jangar-db-rw` and rewriting the URI to `127.0.0.1`

If your database lives outside your current kubectl namespace, export `MEMORIES_KUBE_NAMESPACE=<namespace>` before running the scripts.

### Local Postgres (optional)

Bootstrapping the local Postgres schema creates a dedicated `cerebrum` role and database. Run:

```bash
bun run createdb
```

The script checks for `cerebrum` before creating the role/database and leaves the password set to `cerebrum` so the bundled helpers can connect locally.

Set `DATABASE_URL` to `postgres://cerebrum:cerebrum@localhost:5432/cerebrum?sslmode=disable` (see `.env.example`) when working locally.

### Required environment

- `DATABASE_URL` – optional override for the Postgres endpoint (pgvector-enabled) with the `memories` schema.
- `OPENAI_API_KEY` – key used for embedding API calls (required for hosted OpenAI, optional for self-hosted endpoints).
- `OPENAI_EMBEDDING_MODEL` – optional (defaults to `text-embedding-3-small` on OpenAI, or `qwen3-embedding:0.6b` when using a self-hosted base URL).
- `OPENAI_EMBEDDING_DIMENSION` – optional (defaults to `1536` on OpenAI, or `1024` for the self-hosted model).
- `OPENAI_API_BASE_URL` – optional (defaults to `http://192.168.1.190:11434/v1`).

Optional Kubernetes overrides:

- `MEMORIES_KUBE_NAMESPACE` – namespace to read secrets/port-forward (defaults to kubectl current namespace).
- `MEMORIES_KUBE_SECRET` – override the secret name (defaults to `jangar-db-app`).
- `MEMORIES_KUBE_SERVICE` – override the Postgres service (defaults to `svc/jangar-db-rw`).
- `MEMORIES_KUBE_PORT` – override the Postgres port (defaults to `5432`).

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
