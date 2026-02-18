# memories

This directory hosts Bun CLI helpers for saving and retrieving memories via Jangar's REST endpoint.

Note: this service is intended for local/dev agents. Production deployments should use Jangar directly (`services/jangar`).

## Setup

```bash
bun install
```

### Jangar endpoint

By default the helpers auto-detect runtime and use the REST endpoints:

- `POST /api/memories`
- `GET /api/memories`

Default base URL selection:

- In Kubernetes namespace `jangar`: `http://jangar`
- In any other Kubernetes namespace: `http://jangar.jangar.svc.cluster.local`
- Outside Kubernetes: `http://jangar.ide-newton.ts.net`

Override the base URL by setting `MEMORIES_JANGAR_URL` (or `JANGAR_BASE_URL` / `MEMORIES_BASE_URL`).
For debugging Kubernetes auto-detection, you can set `MEMORIES_K8S_NAMESPACE`.

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
- `--task-name` – optional namespace filter. If omitted, searches across all namespaces.
- `--limit` – up to how many matches to return (defaults to `5`).
- `--repository-ref`, `--source`, `--tags` are ignored by the REST endpoint and will emit a warning when supplied.

## Testing

```bash
bun test tests
```

## Database schema

Jangar handles embeddings + storage internally. Apply `schemas/embeddings/memories.sql` only if you are provisioning a new Jangar database.
