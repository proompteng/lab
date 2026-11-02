# memories

This directory hosts Bun CLI helpers for saving and retrieving memories through the Agents memory note API.

Note: this service is intended for local/dev agents. Production deployments should use the Agents service directly (`services/agents`).

## Setup

```bash
bun install
```

### Agents endpoint

By default the helpers auto-detect runtime and use the REST endpoints:

- `POST /v1/memory-notes`
- `GET /v1/memory-notes`

Default base URL selection:

- In Kubernetes namespace `agents`: `http://agents`
- In any other Kubernetes namespace: `http://agents.agents.svc.cluster.local`
- Outside Kubernetes: `http://agents.ide-newton.ts.net`

Override the base URL by setting `MEMORIES_AGENTS_URL` (or `AGENTS_SERVICE_BASE_URL` / `MEMORIES_BASE_URL`).
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
- Other flags are ignored by the Agents memory note endpoint and will emit a warning when supplied.

### Retrieve memories

```bash
bun run retrieve-memory --query "what did we build" --limit 5
```

- `--query` or `--query-file` – the prompt used to search the memory store.
- `--task-name` – optional namespace filter. If omitted, searches across all namespaces.
- `--limit` – up to how many matches to return (defaults to `5`).
- `--repository-ref`, `--source`, `--tags` are ignored by the Agents memory note endpoint and will emit a warning when supplied.

## Testing

```bash
bun test tests
```

## Database schema

Agents handles embeddings and storage internally through the Agents-owned `memories.entries` table and migrations.
