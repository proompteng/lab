# memories

This directory hosts Bun CLI helpers for saving and retrieving memories via Jangar's REST endpoint.

Note: this service is intended for local/dev agents. Production deployments should use Jangar directly (`services/jangar`).

## Setup

```bash
bun install
```

### Jangar endpoint

By default the helpers call the Jangar Tailscale service at `http://jangar` and use the REST endpoints:

- `POST /api/memories`
- `GET /api/memories`

Override the base URL by setting `MEMORIES_JANGAR_URL` (or `JANGAR_BASE_URL`).

## Scripts

### Save a memory

```bash
bun run save-memory --task-name "describe repo" --content "we changed X" \
  --summary "repo update" --tags task,repo
```

- `--content` or `--content-file` – the block of text to store.
- `--task-name` – namespace to store under (required).
- `--summary` – short overview (defaults to the first 300 characters of content).
- `--tags` – comma-separated list.
- Other flags are ignored by the REST endpoint and will emit a warning when supplied.

### Retrieve memories

```bash
bun run retrieve-memory --query "what did we build" --limit 5
```

- `--query` or `--query-file` – the prompt used to search the memory store.
- `--task-name` – namespace filter.
- `--limit` – up to how many matches to return (defaults to `5`).
- `--repository-ref`, `--source`, `--tags` are ignored by the REST endpoint and will emit a warning when supplied.

## Testing

```bash
bun test tests
```

## Database schema

Jangar handles embeddings + storage internally. Apply `schemas/embeddings/memories.sql` only if you are provisioning a new Jangar database.
